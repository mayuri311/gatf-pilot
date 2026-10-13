import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getAdminSupabase } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/common/page-header";
import { Panel } from "@/components/common/panel";
import { EmptyState } from "@/components/common/states";
import { CreateUserDialog, UsersTable, type AdminUser } from "@/components/admin/users-table";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const me = await requireAdmin();
  const nowMs = new Date().getTime();
  let users: AdminUser[] = [];
  let error: string | null = null;
  try {
    const { data, error: e } = await getAdminSupabase().auth.admin.listUsers({ page: 1, perPage: 500 });
    if (e) throw e;
    users = data.users
      .map((u) => {
        const meta = (u.app_metadata ?? {}) as Record<string, unknown>;
        const bannedUntil = (u as { banned_until?: string | null }).banned_until;
        return {
          id: u.id,
          email: u.email ?? "(no email)",
          role: typeof meta.role === "string" ? meta.role : null,
          mustChange: meta.must_change_password === true,
          banned: !!bannedUntil && Date.parse(bannedUntil) > nowMs,
          createdAt: u.created_at ?? null,
          lastSignIn: u.last_sign_in_at ?? null,
        };
      })
      .sort((a, b) => (a.role === b.role ? a.email.localeCompare(b.email) : a.role === "admin" ? -1 : 1));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Invite-only accounts · admins manage everything, staff are read-only · all changes are audit-logged"
        actions={<CreateUserDialog />}
      />
      <Panel>
        {error ? (
          <div className="p-5">
            <EmptyState title="Couldn't load users">{error}</EmptyState>
          </div>
        ) : (
          <UsersTable users={users} selfId={me.id} />
        )}
      </Panel>
    </>
  );
}
