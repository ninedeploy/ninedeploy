FROM composer:2 AS composer

FROM php:8.4-apache-bookworm AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
COPY composer.json composer.lock ./
RUN COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --prefer-dist --no-scripts --no-plugins

FROM php:8.4-apache-bookworm
WORKDIR /var/www/html
ENV APP_ENV=production APP_DEBUG=false
COPY --from=dependencies /app/vendor ./vendor
COPY bootstrap ./bootstrap
COPY routes ./routes
COPY public ./public
COPY deploy/apache.conf /etc/apache2/sites-available/000-default.conf
RUN mkdir -p bootstrap/cache storage/framework/cache storage/framework/sessions storage/framework/views storage/logs \
    && chown -R www-data:www-data bootstrap/cache storage
EXPOSE 80
