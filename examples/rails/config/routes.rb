Rails.application.routes.draw do
  root "home#index"

  # The health check the deployment waits for (.ninedeploy: run.healthcheck).
  get "healthz", to: "home#health"
end
