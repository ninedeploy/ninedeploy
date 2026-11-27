# The binary is built in one stage; the image that runs holds nothing but it.
# The standard library is all this service uses, so there is nothing to lock: the base image pins
# the Go toolchain. With a dependency, `go mod tidy` writes go.sum, which `go.*` copies with go.mod.
FROM golang:1.27.4-bookworm AS build
WORKDIR /src
COPY go.* ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/app"]
