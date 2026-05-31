import { apiFetch } from "@/lib/api/client";

export interface LibrarySharingTarget {
  id: string;
  role: string;
}

export interface LibraryMember {
  user_id: string;
  role: string;
  is_owner: boolean;
  email?: string | null;
  display_name?: string | null;
  created_at: string;
}

export interface LibraryInvite {
  id: string;
  library_id: string;
  inviter_user_id: string;
  invitee_user_id: string;
  role: string;
  status: string;
  invitee_email?: string | null;
  invitee_display_name?: string | null;
  created_at: string;
}

export interface UserSearchResult {
  user_id: string;
  email: string | null;
  display_name: string | null;
}

export interface EditableLibrarySharing {
  members: LibraryMember[];
  invites: LibraryInvite[];
}

export async function fetchEditableLibrarySharing(
  library: LibrarySharingTarget,
): Promise<EditableLibrarySharing> {
  if (library.role !== "admin") {
    return { members: [], invites: [] };
  }

  const [membersResponse, invitesResponse] = await Promise.all([
    apiFetch<{ data: LibraryMember[] }>(`/api/libraries/${library.id}/members`),
    apiFetch<{ data: LibraryInvite[] }>(`/api/libraries/${library.id}/invites`),
  ]);

  return {
    members: membersResponse.data,
    invites: invitesResponse.data,
  };
}
