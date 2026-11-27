FROM python:3.14-slim-bookworm
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY manage.py ./
COPY project ./project
# A user of its own, with a home directory: gunicorn keeps its worker control socket under $HOME.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app
USER app
EXPOSE 8000
# gunicorn answers on all interfaces; only the proxy reaches the container. The access log goes to stdout.
CMD ["gunicorn", "project.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2", "--access-logfile", "-", "--forwarded-allow-ips", "*"]
