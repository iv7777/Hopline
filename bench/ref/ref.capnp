using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .w), (name = "net", network = (allow = ["public", "private", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:8788", http = (), service = "main") ],
);
const w :Workerd.Worker = ( modules = [ (name = "ref.js", esModule = embed "ref.js") ], compatibilityDate = "2025-09-01", globalOutbound = "net" );
