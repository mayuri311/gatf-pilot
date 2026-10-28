#!/usr/bin/env python3
"""
TensorRT (GPU) backend for the plate reader's detector.

fast_alpr runs the plate detector (open_image_models YOLOv9) and the OCR model
(fast_plate_ocr) through onnxruntime, and each library makes exactly one call
into it: `session.run(output_names, {input_name: array})`. TrtSession offers
that same run() on top of a TensorRT engine, so use_tensorrt() can swap it in
under an existing ALPR object while every bit of the libraries' pre- and
post-processing stays as it is - only the inference math moves to the GPU.

Only the detector moves by default. Measured on recorded 1080p footage: detector
121 ms/frame on CPU (2 threads) vs 16.9 ms with TensorRT FP16, identical
detections (same counts, boxes within 1 px). OCR is 14 ms per plate on CPU and
only runs on frames that contain a plate, while building its engine (a CCT
transformer) took over 20 minutes and 2.7 GB RAM without finishing - not worth
it. use_tensorrt(alpr, ocr=True) still exists for trying it.

The onnxruntime pip wheel for aarch64 is CPU-only, and PyPI's generic aarch64
onnxruntime-gpu has no TensorRT provider and no native Orin (sm_87) kernels, so
this uses JetPack's own TensorRT (apt: python3-libnvinfer, libnvinfer10, ...)
directly, with CUDA memory handled through libcudart via ctypes.

Engines are built once per (model file, TensorRT version, precision) and cached
in ENGINE_DIR; a file lock keeps two readers starting at once from both
building. Prebuild them (a few minutes, run_pipeline.sh does this) with:
    python scripts/trt_backend.py --build
"""

import argparse
import ctypes
import fcntl
import hashlib
import os
import sys
from pathlib import Path

import numpy as np

ENGINE_DIR = Path(os.environ.get("GATF_TRT_CACHE", Path.home() / ".cache" / "gatf-trt"))

# The OCR model takes a dynamic batch of plate crops; fast_alpr sends one at a time.
OCR_MAX_BATCH = 8

_H2D, _D2H = 1, 2  # cudaMemcpyKind


class TensorRTUnavailable(RuntimeError):
    pass


def _trt():
    try:
        import tensorrt as trt
    except ImportError as exc:
        raise TensorRTUnavailable(
            "TensorRT Python bindings not found (sudo apt install python3-libnvinfer; "
            "the venv needs --system-site-packages)") from exc
    return trt


class _Cuda:
    """The handful of CUDA runtime calls needed, via ctypes - no pycuda/cuda-python."""

    def __init__(self):
        try:
            self.lib = ctypes.CDLL("libcudart.so.13")
        except OSError as exc:
            raise TensorRTUnavailable(f"CUDA runtime not found ({exc}); sudo apt install cuda-cudart-13-2") from exc
        for name in ("cudaMalloc", "cudaFree", "cudaMemcpyAsync", "cudaStreamCreate",
                     "cudaStreamSynchronize", "cudaStreamDestroy"):
            getattr(self.lib, name).restype = ctypes.c_int
        self.lib.cudaMemcpyAsync.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
                                             ctypes.c_int, ctypes.c_void_p]

    def check(self, err, what):
        if err != 0:
            raise RuntimeError(f"{what} failed with CUDA error {err}")

    def malloc(self, nbytes):
        ptr = ctypes.c_void_p()
        self.check(self.lib.cudaMalloc(ctypes.byref(ptr), ctypes.c_size_t(max(int(nbytes), 1))), "cudaMalloc")
        return ptr.value

    def free(self, ptr):
        if ptr:
            self.lib.cudaFree(ctypes.c_void_p(ptr))

    def stream(self):
        s = ctypes.c_void_p()
        self.check(self.lib.cudaStreamCreate(ctypes.byref(s)), "cudaStreamCreate")
        return s.value

    def h2d(self, dst, arr, stream):
        self.check(self.lib.cudaMemcpyAsync(dst, arr.ctypes.data, arr.nbytes, _H2D, stream), "cudaMemcpy H2D")

    def d2h(self, arr, src, stream):
        self.check(self.lib.cudaMemcpyAsync(arr.ctypes.data, src, arr.nbytes, _D2H, stream), "cudaMemcpy D2H")

    def sync(self, stream):
        self.check(self.lib.cudaStreamSynchronize(ctypes.c_void_p(stream)), "cudaStreamSynchronize")


def engine_path(onnx_path, fp16=True):
    trt = _trt()
    digest = hashlib.sha256(Path(onnx_path).read_bytes()).hexdigest()[:12]
    return ENGINE_DIR / f"{Path(onnx_path).stem}-{digest}-trt{trt.__version__}-{'fp16' if fp16 else 'fp32'}.engine"


def build_engine(onnx_path, fp16=True, max_batch=OCR_MAX_BATCH, log=print):
    """Build (or reuse) the cached engine for onnx_path. Returns its path."""
    trt = _trt()
    out = engine_path(onnx_path, fp16)
    if out.exists():
        return out
    ENGINE_DIR.mkdir(parents=True, exist_ok=True)
    with open(ENGINE_DIR / ".build.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)          # another reader may be building it right now
        if out.exists():
            return out
        log(f"[trt] building {out.name} (one-time, a few minutes)...")
        logger = trt.Logger(trt.Logger.WARNING)
        builder = trt.Builder(logger)
        network = builder.create_network(0)
        parser = trt.OnnxParser(network, logger)
        if not parser.parse(Path(onnx_path).read_bytes()):
            errors = "; ".join(str(parser.get_error(i)) for i in range(parser.num_errors))
            raise RuntimeError(f"TensorRT could not parse {onnx_path}: {errors}")
        config = builder.create_builder_config()
        config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, 512 << 20)
        if fp16:
            config.set_flag(trt.BuilderFlag.FP16)
        profile = None
        for i in range(network.num_inputs):
            tensor = network.get_input(i)
            shape = tuple(tensor.shape)
            if any(d < 0 for d in shape):                 # dynamic batch dim only
                fixed = tuple(d for d in shape[1:])
                profile = profile or builder.create_optimization_profile()
                profile.set_shape(tensor.name, (1, *fixed), (1, *fixed), (max_batch, *fixed))
        if profile is not None:
            config.add_optimization_profile(profile)
        serialized = builder.build_serialized_network(network, config)
        if serialized is None:
            raise RuntimeError(f"TensorRT engine build failed for {onnx_path}")
        tmp = out.with_suffix(".tmp")
        tmp.write_bytes(bytes(serialized))
        os.replace(tmp, out)
        log(f"[trt] built {out.name}")
        return out


class TrtSession:
    """Engine-backed stand-in for an onnxruntime InferenceSession's run()."""

    def __init__(self, engine_file):
        trt = _trt()
        self.trt = trt
        self.cuda = _Cuda()
        self.logger = trt.Logger(trt.Logger.WARNING)
        self.runtime = trt.Runtime(self.logger)
        self.engine = self.runtime.deserialize_cuda_engine(Path(engine_file).read_bytes())
        if self.engine is None:
            raise RuntimeError(f"could not load TensorRT engine {engine_file}")
        self.context = self.engine.create_execution_context()
        self.stream = self.cuda.stream()
        names = [self.engine.get_tensor_name(i) for i in range(self.engine.num_io_tensors)]
        is_input = lambda n: self.engine.get_tensor_mode(n) == trt.TensorIOMode.INPUT
        self.inputs = [n for n in names if is_input(n)]
        self.outputs = [n for n in names if not is_input(n)]
        self.dtype = {n: np.dtype(trt.nptype(self.engine.get_tensor_dtype(n))) for n in names}
        self._in_buf = {}                                   # name -> (ptr, nbytes)
        self._alloc = {n: _OutputAllocator(trt, self.cuda) for n in self.outputs}
        for n, alloc in self._alloc.items():
            self.context.set_output_allocator(n, alloc)

    def get_providers(self):
        return ["TensorRT"]

    def run(self, output_names, feed):
        for name in self.inputs:
            arr = np.ascontiguousarray(feed[name], dtype=self.dtype[name])
            ptr, size = self._in_buf.get(name, (0, 0))
            if arr.nbytes > size:
                self.cuda.free(ptr)
                ptr, size = self.cuda.malloc(arr.nbytes), arr.nbytes
                self._in_buf[name] = (ptr, size)
            self.context.set_input_shape(name, arr.shape)
            self.cuda.h2d(ptr, arr, self.stream)
            self.context.set_tensor_address(name, ptr)
            feed[name] = arr  # keep the host array alive until the copy has run
        if not self.context.execute_async_v3(self.stream):
            raise RuntimeError("TensorRT execution failed")
        self.cuda.sync(self.stream)
        results = {}
        for name in self.outputs:
            alloc = self._alloc[name]
            host = np.empty(alloc.shape, dtype=self.dtype[name])
            if host.size:
                self.cuda.d2h(host, alloc.ptr, self.stream)
            results[name] = host
        self.cuda.sync(self.stream)
        return [results[n] for n in (output_names or self.outputs)]


class _OutputAllocator:
    """TensorRT asks this for output memory once it knows the shape - needed for the
    detector's data-dependent [num_detections, 7] output; harmless for fixed ones."""

    def __new__(cls, trt, cuda):
        class Impl(trt.IOutputAllocator):
            def __init__(self):
                trt.IOutputAllocator.__init__(self)
                self.ptr, self.size, self.shape = 0, 0, ()

            def reallocate_output(self, tensor_name, memory, size, alignment):
                if size > self.size:
                    cuda.free(self.ptr)
                    self.ptr, self.size = cuda.malloc(size), max(int(size), 1)
                return self.ptr

            def reallocate_output_async(self, tensor_name, memory, size, alignment, stream=None):
                return self.reallocate_output(tensor_name, memory, size, alignment)

            def notify_shape(self, tensor_name, shape):
                self.shape = tuple(shape)

        return Impl()


def _session_model_path(session, cache_glob):
    # neither library keeps the path; onnxruntime's session does (private attr), else the
    # download cache the libraries use
    path = getattr(session, "_model_path", None)
    if path and Path(path).exists():
        return Path(path)
    hits = sorted(Path.home().glob(cache_glob))
    if not hits:
        raise RuntimeError(f"cannot locate the ONNX model ({cache_glob})")
    return hits[0]


def model_paths(alpr):
    """The ONNX files behind an ALPR object's (still CPU) detector and OCR sessions."""
    return (
        _session_model_path(alpr.detector.detector.model,
                            ".cache/open-image-models/yolo-v9-t-384-license-plate-end2end/*.onnx"),
        _session_model_path(alpr.ocr.ocr_model.model,
                            ".cache/fast-plate-ocr/cct-xs-v2-global-model/*.onnx"),
    )


def use_tensorrt(alpr, fp16=True, ocr=False, log=print):
    """Swap a TensorRT session in under alpr's detector (and OCR, if asked). Raises
    TensorRTUnavailable / RuntimeError if that's not possible - callers fall back
    to the CPU sessions, which are left untouched in that case."""
    det_onnx, ocr_onnx = model_paths(alpr)
    det = TrtSession(build_engine(det_onnx, fp16, log=log))
    ocr_session = TrtSession(build_engine(ocr_onnx, fp16, log=log)) if ocr else None
    alpr.detector.detector.model = det
    if ocr_session is not None:
        alpr.ocr.ocr_model.model = ocr_session
    return det, ocr_session


def _default_alpr():
    from fast_alpr import ALPR
    return ALPR(detector_model="yolo-v9-t-384-license-plate-end2end",
                ocr_model="cct-xs-v2-global-model", detector_providers=["CPUExecutionProvider"],
                ocr_providers=["CPUExecutionProvider"])


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Build the plate reader's TensorRT engines")
    ap.add_argument("--build", action="store_true", help="build (or confirm) the cached engines")
    ap.add_argument("--fp32", action="store_true", help="full precision instead of FP16")
    ap.add_argument("--ocr", action="store_true", help="also build the OCR engine (slow, not used by default)")
    args = ap.parse_args()
    if not args.build:
        ap.print_help()
        sys.exit(0)
    try:
        det_onnx, ocr_onnx = model_paths(_default_alpr())
        for p in [det_onnx] + ([ocr_onnx] if args.ocr else []):
            print(f"{p.name}: {build_engine(p, fp16=not args.fp32)}")
    except (TensorRTUnavailable, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
