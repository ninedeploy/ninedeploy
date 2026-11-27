# Puma serves the application on all interfaces; only the proxy reaches the container.
listen_port = Integer(ENV.fetch("PORT", 3000))
environment ENV.fetch("RAILS_ENV", "production")

workers 0
threads 1, 3

bind "tcp://0.0.0.0:#{listen_port}"
