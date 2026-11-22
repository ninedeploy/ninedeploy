from fastapi import FastAPI

app = FastAPI(title="NineDeploy FastAPI starter")


@app.get("/")
def index() -> dict[str, str]:
    return {"starter": "NineDeploy FastAPI starter"}


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}
