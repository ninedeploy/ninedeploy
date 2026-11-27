class HomeController < ApplicationController
  def index
    render :index, layout: false
  end

  # The health check the deployment waits for (.ninedeploy: run.healthcheck).
  def health
    render json: { status: "ok" }
  end
end
