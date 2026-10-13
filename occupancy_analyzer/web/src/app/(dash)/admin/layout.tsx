import { requireAdmin } from "@/lib/auth";

/** Every /admin/* page is admin-only (server-side check; RPCs re-check the role). */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAdmin();
  return children;
}
