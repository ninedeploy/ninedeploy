require_relative "boot"

require "rails"

# The frameworks this service uses. Active Record, the mailers, Active Storage, Action Cable and
# the asset pipeline are left out: it keeps no state and builds no assets. Add the ones you need
# as you would in any Rails application, with a database attached under the service's Databases.
require "active_model/railtie"
require "active_job/railtie"
require "action_controller/railtie"
require "action_view/railtie"
require "rails/test_unit/railtie"

Bundler.require(*Rails.groups)

module Starter
  class Application < Rails::Application
    config.load_defaults 8.1

    # The proxy in front sends the service's own hostname, whatever it is.
    config.hosts.clear

    # The starter keeps no session and signs nothing, so the key protects nothing yet; Rails
    # refuses to serve production without one. Set SECRET_KEY_BASE in the service's environment
    # before you add anything that needs a key (`bin/rails secret` writes one).
    config.secret_key_base = ENV["SECRET_KEY_BASE"].presence || "ninedeploy-starter"

    # The log goes to stdout, where the service's log tab reads it.
    config.logger = ActiveSupport::TaggedLogging.new(Logger.new($stdout))
  end
end
