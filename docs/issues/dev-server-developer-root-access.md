# dev-server developer account retains root access

observed read-only on 2026-11-15 while assessing backend colocation. the existing
frontend and jarvis are already affected by this shared-host boundary.

`ssh dev-server-deploy 'sudo -n -l -U niels'` reports
`(ALL) NOPASSWD: ALL`. the grant is in
`/etc/sudoers.d/90-cloud-init-users:4`: `niels ALL=(ALL) NOPASSWD:ALL`.
the active self-hosted github runner also runs as `niels`.

the dev-server owner intends deployment-only elevation:
`ansible/roles/security/tasks/main.yml:59-71` installs the deployment grant but
removes only `/etc/sudoers.d/90-devbox-{{ devbox_user }}`. the surviving cloud-init
grant makes separate production service accounts ineffective against compromise
of an unrestricted developer or runner process. contained native-host units have
additional restrictions; this finding concerns the account's ordinary processes.

fix belongs to dev-server's security convergence. remove the effective developer
root grant while retaining separately authenticated deployment administration;
inspect remaining group, socket, credential and allowed-command paths to the same
authority. do not modify unrelated sudoers entries or disable working admin access.

resolved when effective policy and a fresh developer-session check deny root
elevation, deployment access still works, and development/runner processes cannot
reach production controls, secrets or storage through another privileged path.
no policy was changed during this assessment.

the frontend caller also depends on the accidental privilege:
`deploy/web/controller.py:24-35` connects as `dev-server`/`niels` and uses sudo.
move it to the existing `dev-server-deploy` identity before removing the grant.
backend inspection and mutation must select the system docker socket explicitly;
the developer's rootless engine remains a separate owner.
