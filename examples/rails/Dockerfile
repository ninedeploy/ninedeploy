FROM ruby:3.4-slim AS dependencies
WORKDIR /app
# A compiler for the gems that build an extension (bigdecimal, json); the runtime stage has none.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY Gemfile Gemfile.lock ./
# The gems go into the application's directory, with the versions Gemfile.lock names.
ENV BUNDLE_PATH=vendor/bundle
RUN bundle install --jobs 4 --retry 3

FROM ruby:3.4-slim
WORKDIR /app
ENV RAILS_ENV=production BUNDLE_PATH=vendor/bundle
COPY --from=dependencies /app/vendor/bundle ./vendor/bundle
COPY Gemfile Gemfile.lock config.ru ./
COPY config ./config
COPY app ./app
RUN useradd --create-home --shell /usr/sbin/nologin rails && chown -R rails:rails /app
USER rails
EXPOSE 3000
CMD ["bundle", "exec", "puma", "-C", "config/puma.rb"]
