#!/usr/bin/env python3
"""
Simple license plate reader for the Axis camera feed.
OpenCV Haar cascade finds candidate plate regions -> Tesseract OCR reads the text
-> bounding box + text are drawn on the live frame.

Axis RTSP URL format:
    rtsp://<user>:<pass>@<camera-ip>/axis-media/media.amp

Usage:
    python plate_reader.py --source "rtsp://user:pass@192.168.1.64/axis-media/media.amp"
    python plate_reader.py --source lot.mp4      # test on a video file first
    python plate_reader.py --source 0            # test on a webcam
"""

import argparse
import re

import cv2
import pytesseract

CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_russian_plate_number.xml")
# Plates read as mostly garbage unless we restrict Tesseract to plate-like characters.
OCR_CONFIG = "--psm 8 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"


def read_plate_text(plate_img):
    gray = cv2.cvtColor(plate_img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    gray = cv2.bilateralFilter(gray, 11, 17, 17)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    text = pytesseract.image_to_string(thresh, config=OCR_CONFIG)
    text = re.sub(r"[^A-Z0-9]", "", text.upper())
    return text


def run(source):
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open source: {source}")

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        plates = CASCADE.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 20))

        for (x, y, w, h) in plates:
            plate_img = frame[y:y + h, x:x + w]
            text = read_plate_text(plate_img)

            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
            if text:
                cv2.putText(frame, text, (x, y - 10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

        cv2.imshow("license plate reader", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True,
                     help="Axis RTSP URL, video file, or webcam index")
    args = ap.parse_args()

    src = int(args.source) if args.source.isdigit() else args.source
    run(src)

# Axis rtsp url is rtsp://
