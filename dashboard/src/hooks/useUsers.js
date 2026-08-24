import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as usersService from '../services/usersService.js'

// Settings -> Users & Access (Multi-Location Authentication & User Access
// System, Commit 6) -- read query + one mutation hook per action, all
// invalidating the same ['users-list'] key on success so the table always
// reflects the real server state after any change, matching
// useAuditLog.js/useActionWorkspace.js's own established pattern.
export function useUsersList() {
  return useQuery({
    queryKey: ['users-list'],
    queryFn: usersService.listUsers,
    staleTime: 30 * 1000,
  })
}

function useUsersMutation(fn) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users-list'] }),
  })
}

export function useInviteUser()            { return useUsersMutation(usersService.inviteUser) }
export function useResendInvite()           { return useUsersMutation(usersService.resendInvite) }
export function useRevokeInvite()           { return useUsersMutation(usersService.revokeInvite) }
export function useGenerateResetLink()      { return useUsersMutation(usersService.generateResetLink) }
export function useUpdateUserRoleLocations() { return useUsersMutation(usersService.updateUserRoleLocations) }
export function useDisableUser()            { return useUsersMutation(usersService.disableUser) }
export function useEnableUser()             { return useUsersMutation(usersService.enableUser) }
