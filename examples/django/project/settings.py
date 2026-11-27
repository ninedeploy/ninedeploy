"""Settings for the starter project: the least a Django service needs to answer HTTP."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# The starter keeps no session and signs nothing, so the key protects nothing yet. Set
# DJANGO_SECRET_KEY in the service's environment before you add anything that needs one.
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "ninedeploy-starter")

DEBUG = False

# The proxy in front decides who may reach the service; it sends any hostname the service has.
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS: list[str] = []

MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "project.urls"

WSGI_APPLICATION = "project.wsgi.application"

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
