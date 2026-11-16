# host convergence can disable the production docker daemon

the proposed backend uses system docker; development retains its existing
rootless engine. dev-server's `ansible/roles/rootless_docker/tasks/main.yml:39-75`
currently disables system `docker.service` and `docker.socket` when stopped or
when no containers are running. an empty production maintenance window would
therefore cause ordinary host convergence to disable the backend's runtime.

dev-server must explicitly own system docker availability for nexus, remove that
retirement branch, and keep the two sockets and data roots distinct. preserve the
rootless engine. only the deployment principal may administer system docker.

resolved when an ordinary apply leaves both engines correctly configured with
and without running production containers, an ordinary developer cannot access
the system socket, and the production release always selects that socket.
