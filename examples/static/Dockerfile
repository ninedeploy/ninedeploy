# Nothing is built: the site is copied into a web server that runs without root.
FROM nginxinc/nginx-unprivileged:1.30-alpine
COPY public/ /usr/share/nginx/html/
COPY deploy/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
