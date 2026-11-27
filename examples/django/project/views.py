from django.http import HttpRequest, JsonResponse


def index(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"starter": "NineDeploy Django starter"})


# The health check the deployment waits for (.ninedeploy: run.healthcheck).
def health(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"status": "ok"})
