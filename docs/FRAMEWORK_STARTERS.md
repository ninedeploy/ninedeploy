# Framework starters

Deploy a small application in one of ten frameworks from a local folder: Next.js, Laravel, FastAPI, Django, Rails, Express, Astro, Go, Spring Boot, or a static site. Each example includes a Dockerfile, a `.ninedeploy` manifest that sets the application port and the `/healthz` readiness path, and a lockfile where the framework has one. Each home page names its starter, and `/healthz` answers `{"status":"ok"}`.

| Starter | Runtime | Container port |
| --- | --- | ---: |
| [Next.js](../examples/nextjs) | Node.js 24, Next.js standalone server | 3000 |
| [Laravel](../examples/laravel) | PHP 8.4 and Apache | 80 |
| [FastAPI](../examples/fastapi) | Python 3.14 and Uvicorn | 8000 |
| [Django](../examples/django) | Python 3.14, Django 6.1 and Gunicorn | 8000 |
| [Rails](../examples/rails) | Ruby 3.4, Rails 8.1 and Puma | 3000 |
| [Express](../examples/express) | Node.js 26, Express 5 | 3000 |
| [Astro](../examples/astro) | Node.js 26 builds the site; nginx serves it | 8080 |
| [Go](../examples/go) | Go 1.27, the standard library only | 8080 |
| [Spring Boot](../examples/spring) | Java 21, Spring Boot 4.2 with an embedded Tomcat | 8080 |
| [Static site](../examples/static) | nginx; nothing is built | 8080 |

The images run as a user of their own, with the exception of Laravel's Apache, which starts as root and passes each request to `www-data` as the base image does.

## Deploy from your machine

1. Install NineDeploy and finish setup using the [Quickstart](QUICKSTART.md). If the panel must use the sibling prober because it cannot reach container IPs directly, use a build that includes the readiness fix below. Sign in to the CLI with `ninedeploy login`. Your account needs permission to create a service.
2. From the NineDeploy checkout, run the command for the framework you want. Each example directory is also a self-contained project root you can copy into a new repository.

   ```bash
   ninedeploy deploy up ./examples/nextjs --create nextjs-starter
   ninedeploy deploy up ./examples/laravel --create laravel-starter --exclude vendor
   ninedeploy deploy up ./examples/fastapi --create fastapi-starter
   ninedeploy deploy up ./examples/django --create django-starter
   ninedeploy deploy up ./examples/rails --create rails-starter --exclude vendor .bundle
   ninedeploy deploy up ./examples/express --create express-starter
   ninedeploy deploy up ./examples/astro --create astro-starter
   ninedeploy deploy up ./examples/go --create go-starter
   ninedeploy deploy up ./examples/spring --create spring-starter --exclude target
   ninedeploy deploy up ./examples/static --create static-starter
   ```

3. Open the service in the panel and wait for the deployment to finish. If a build fails, open its deployment log. Use the service URL to open `/` and confirm the framework's starter message. Request `/healthz` to check for HTTP 200 and `{"status":"ok"}`.
4. For public HTTPS, point a DNS record at your server and add the hostname with HTTPS enabled in the service's Domains tab. Follow the DNS and certificate prerequisites in the [Traefik ingress guide](TRAEFIK_INGRESS.md). If you have no service URL yet, start with an [automatic URL or a custom domain](TRAEFIK_INGRESS.md#automatic-urls-0161).

You can also upload an archive through **New → Upload source**. Put the Dockerfile and `.ninedeploy` at the root of the archive and include the lockfile. Keep credentials and local dependencies outside the archive. [Source upload guide](DEPLOYMENTS.md#deploy-without-git-uploaded-source-0161)

### Recover a failed upload deployment

After **Create and deploy**, the panel opens the service's **Deploys** tab. If a build fails, the deployment output shows the failed step and any error detail recorded for it. Select **Jump to failed step** to find that step in the build log. Review the failing command or check before changing the source.

Use **Upload new version** on the same service to send a corrected archive. This queues a new deployment and keeps the earlier attempt in history. If the upload itself was rejected after the service was created, the panel displays the rejection and opens the same **Deploys** tab so you can upload again there.

On November 22, 2026, the browser journey reproduced the missing **Deploys** hand-off on the previous panel image. On the updated image (`sha256:504f8e892750af3cff0bb7044d67e37dab46b151954579dd3e36d88a828bdf4e`), a disposable Dockerfile exited with code 37 during the first build. The browser opened **Deploys**, showed **Build failed**, and jumped to the step containing the Dockerfile output. A corrected upload reached `running` on the same service, the failed attempt remained in history, and Traefik served the corrected application's response.

## Customize the starter

- **Next.js** uses App Router with `app/page.js` as its entry page. The runtime image copies the standalone server and the generated static assets. If you add a `public/` directory, add a Dockerfile `COPY` for it into the runtime image. Regenerate `package-lock.json` with `npm install` from the project directory when you change dependencies. [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- **Laravel** serves the `public/` directory and registers the example routes in `routes/web.php`. The sample is stateless. When adding sessions or authentication, provide `APP_KEY` through service environment variables and configure persistence for your application. Use PHP 8.4 and run `composer update` from the project directory to regenerate `composer.lock`. [Laravel deployment guide](https://laravel.com/framework/docs/13.x/deployment)
- **FastAPI** serves `main:app` with Uvicorn. Change `requirements.in` and run `uv pip compile requirements.in --python-version 3.14 --universal --generate-hashes --output-file requirements.txt` from the project directory to update the hash-checked lockfile. [FastAPI container guide](https://fastapi.tiangolo.com/deployment/docker/)
- **Django** serves the `project` application with Gunicorn on two workers. It registers no application and keeps no database. When you attach a managed database to the service, its URL arrives in the environment as `DATABASE_URL` ([databases and backups](DATABASES_BACKUPS.md)); add `django.db` to `INSTALLED_APPS`, give `DATABASES` a setting that reads it, and run the migrations from the service's pre-deploy hook (an instance operator sets hooks). `ALLOWED_HOSTS` accepts any hostname because the proxy in front decides who may reach the service. Django refuses to start without a key, so the starter sets a placeholder: set `DJANGO_SECRET_KEY` in the environment before you add sessions or anything signed. Update `requirements.in` with the same `uv pip compile` command as FastAPI. [Django deployment checklist](https://docs.djangoproject.com/en/stable/howto/deployment/checklist/)
- **Rails** is a full-stack application without Active Record, the mailers, Active Storage, Action Cable and an asset pipeline: `config/application.rb` lists what it loads. Puma reads `PORT` (3000) and `RAILS_ENV` from the environment. `config.hosts.clear` accepts any hostname, and the placeholder `secret_key_base` exists because Rails refuses to serve production without one; set `SECRET_KEY_BASE` in the environment (`bin/rails secret` writes a value) before you add sessions. To add a database, require `active_record/railtie` and write `config/database.yml` from the environment's `DATABASE_URL`. Regenerate `Gemfile.lock` with `bundle lock --add-platform x86_64-linux --add-platform aarch64-linux` from the project directory, so both CPU architectures the panel deploys to stay in the lockfile. [Configuring a Rails application](https://guides.rubyonrails.org/configuring.html)
- **Express** serves `server.js`. It reads `PORT`, falling back to 3000, which is also the port the manifest names. Regenerate `package-lock.json` with `npm install` from the project directory when you change dependencies. [Express behind a proxy](https://expressjs.com/en/guide/behind-proxies.html)
- **Astro** builds a static site with `output: 'static'`. `src/pages/healthz.ts` is a prerendered endpoint, so `/healthz` is a file the web server answers; `src/pages/` holds the pages. For server-rendered pages, follow Astro's [on-demand rendering guide](https://docs.astro.build/en/guides/on-demand-rendering/): install an adapter, set `output` to `'server'`, and give the Dockerfile a Node runtime in place of nginx. An unknown path is a 404: change `try_files` in `deploy/default.conf` to fall back to `index.html` for a single-page app. [Astro deployments](https://docs.astro.build/en/guides/deploy/)
- **Go** uses the standard library only, so there is nothing to lock: the base image pins the Go toolchain, and `go.mod` records the language version. It reads `PORT`, falling back to 8080. The runtime image is Distroless without a shell, which the HTTP health check does not need. With a dependency, `go mod tidy` writes `go.sum`; the Dockerfile already copies it with `go.mod`. [Go modules reference](https://go.dev/ref/mod)
- **Spring Boot** builds with Maven into one jar and runs it on a Java 21 runtime. `spring-boot-starter-parent` in `pom.xml` names the version of every Spring dependency and build plugin, so a build resolves the same libraries until that version changes; a build downloads them from Maven Central. The service listens on 8080. Spring Boot's own health checks live under `/actuator`; this starter answers `/healthz` from a controller so that no extra dependency is needed. [Spring Boot Maven plugin](https://docs.spring.io/spring-boot/maven-plugin/)
- **Static site** copies `public/` into nginx. Nothing is built. `deploy/default.conf` is the server block: add MIME types or caching headers there. An unknown path is a 404; change `try_files` to fall back to `index.html` for a single-page app, and put the build step of your site generator into the Dockerfile before the copy. [nginx beginners' guide](https://nginx.org/en/docs/beginners_guide.html)

## Verify deployments

The **Framework starters** GitHub Actions workflow runs after successful main push CI and uses the panel image from that commit. It builds and routes every starter of the table above, one after another. You can also dispatch it with a candidate image reference. For a local run, use Node.js, `tar` and a local Linux Docker engine that supports a privileged Docker-in-Docker fixture. Network access is required for the framework base images and packages. On Windows, start it from a shell whose `tar` is the one Windows ships (`C:\Windows\System32\tar.exe`): the GNU tar of Git Bash reads the `D:\…` source path as a remote host and fails.

```bash
docker build -t ninedeploy:framework-starters .
node scripts/smoke-framework-starters.mjs --image=ninedeploy:framework-starters
```

The smoke registers a disposable operator and uploads each archive through the API used by `ninedeploy deploy up`. It waits for each deployment to finish, checks the manifest-derived port and deployment readiness probe, and requests both application endpoints through the isolated Traefik listener. The run writes `result.json` and the deployment logs under `.temp_files/framework-starters/`. CI uploads equivalent receipts. The fixture uses private HTTP hostnames under `starters.test`.

### Sibling HTTP readiness fix

The released v0.19.0 image deployed Next.js and Laravel in the isolated fixture. FastAPI served HTTP 200 on `/healthz` when requested directly from the same bridge, but the panel's sibling probe received an empty response and timed out the deployment. The probe piped the request into BusyBox `nc`, which shut down the write half of the socket at EOF before Uvicorn's asynchronous request handling completed. The panel now uses the same bidirectional HTTP probe as node readiness. It keeps the socket open through the response status, uses the inspected container IP and keeps the current readiness status policy. [BusyBox `nc` write-half shutdown](https://lists.busybox.net/pipermail/busybox-cvs/2013-July/034115.html)

### Local acceptance on 2026-11-22

The smoke passed on a Linux amd64 panel image built locally from the updated source (`sha256:a138d12a3122d2e45e9b09f4ac4c98009cba9d8f143544108f12cacd1288fb33`). Every deployment passed its readiness check. Traefik returned HTTP 200 with the expected response on `/` and `/healthz` for all three applications. The run confirmed removal of its disposable containers, network and volume.

| Framework | Upload to deployment success | Upload to verified HTTP routes |
| --- | ---: | ---: |
| Next.js | 47.9 s | 50.8 s |
| Laravel | 42.7 s | 46.2 s |
| FastAPI | 22.4 s | 24.5 s |

These timings cover a single run against a fresh isolated Docker daemon. Hosted runs of the workflow are listed under [Framework starters](https://github.com/ninedeploy/ninedeploy/actions/workflows/framework-starters.yml).

### Local acceptance of the ten starters on 2026-11-27

The seven new starters were built and asked on their own first, then the smoke passed with all ten against the image CI publishes for `main` (`ghcr.io/ninedeploy/ninedeploy:main-407b56e3…`, image `sha256:dbf421ffffad3d9d1d398a367f712870b97603ace9362481aba513691bed6123`, panel 0.20.0), on a fresh isolated Docker daemon on a Windows machine with Docker Desktop. Every deployment passed its readiness check, Traefik returned HTTP 200 with the expected response on `/` and `/healthz` for all ten, and the run removed its containers, network and volume. From the fixture's start to the receipt took about seven and a half minutes, six and a half of them the ten deployments.

| Framework | Upload to deployment success | Upload to verified HTTP routes |
| --- | ---: | ---: |
| Next.js | 45.8 s | 47.5 s |
| Laravel | 37.6 s | 40.5 s |
| FastAPI | 24.4 s | 28.4 s |
| Static site | 18.3 s | 20.0 s |
| Express | 22.5 s | 24.6 s |
| Astro | 25.5 s | 28.6 s |
| Go | 58.1 s | 59.9 s |
| Django | 27.4 s | 31.3 s |
| Rails | 64.0 s | 66.3 s |
| Spring Boot | 80.1 s | 83.3 s |

The images the Dockerfiles build run as a user of their own (`uid` 1000 for Express and Rails, 10001 for Django, 1001 for Spring Boot, 101 for the two nginx sites, and Distroless' `nonroot` for Go); Laravel's Apache is the exception named above. What each build produced on the same machine: Go 15 MiB, the two nginx sites 86 MiB each, Django 237 MiB, Express 337 MiB, Spring Boot 443 MiB, Rails 466 MiB.

The same smoke then ran on GitHub's runner in the workflow of the commit that adds the seven starters ([run 46020814497](https://github.com/ninedeploy/ninedeploy/actions/runs/46020814497)): all ten deployed and answered, 6 min 33 s in all, from 19.5 s for the static site to 58.8 s for Spring Boot, each from upload to verified routes.

## Clean-server first deployment

The test starts with a fresh Ubuntu 24.04.5 LTS QEMU/KVM guest with four vCPUs and 3 GiB of memory. It has no Docker installation, NineDeploy state, or cached container images. Run the pinned Docker-mode installer from the NineDeploy checkout. Start timing when the installer command begins. VM provisioning and fixture preparation happen before the timed interval.

```bash
sudo env DEBIAN_FRONTEND=noninteractive bash ./install.sh --docker --version v0.19.0
```

From a private browser connection, open the installer setup link, create the first operator and use **New → Upload source** to deploy the Next.js example. The test gives the example a unique response marker. Once the deployment reports `running`, add an HTTP hostname for the service in Traefik. Start a disposable Cloudflare Quick Tunnel to that route with the matching origin Host header. The tunnel exposes the example application. The setup and panel endpoints stay on local forwards.

Measure success from a normal HTTPS client with hostname and chain validation enabled. The response must be HTTP 200 and contain the run's marker. Request `/healthz` over the same public endpoint and require HTTP 200 with `{"status":"ok"}`. Stop the tunnel after verification. Cloudflare supplies the public certificate in this test. A custom-domain run using NineDeploy's own ACME resolver requires a public origin or an authorized DNS-01 zone. [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) · [ACME challenges](https://letsencrypt.org/docs/challenge-types/)

### Timing from the November 22, 2026 run

The installer pulled the published v0.19.0 image with digest `sha256:113fb9e11ad3f8f94d38020e00e7744ad10c2f57c614afda89f089db2f4e51bf` and source revision `0a59b5ed4068334b5ee0d1ad36e43959e92525ba`. Each row is elapsed wall time from installer invocation.

| Milestone | Elapsed |
| --- | ---: |
| Panel `/health` reported `ok` | 122.334 s |
| Installer returned successfully | 123.416 s |
| First operator reached the dashboard in a signed-in browser | 123.672 s |
| Next.js source upload submitted | 124.908 s |
| Deployment reported `running` | 185.224 s |
| Service response matched through the Traefik origin | 187.469 s |
| First trusted public HTTPS response matched the application | **257.697 s** |

The public request negotiated TLS 1.3 with a trusted certificate from issuer `WE1`. Both `/` and `/healthz` returned HTTP 200. The tunnel process exited after verification. The interval from the first verified origin response to the first public response was 70.228 seconds in this run. A separate generated tunnel hostname returned NXDOMAIN from both public resolvers checked during preflight. This is one measurement of the Docker-mode installer and temporary public edge. Public issuance and renewal through the built-in ACME resolver remain open.

## Workspace member onboarding

The operator creates a regular account, and the workspace owner adds it as a `member`. In a separate browser session the member signs in, sees the workspace's existing service, and opens **New → Docker image** to deploy another service. Instance user management and built-in demo creation both return HTTP 403 for the member. The workspace role still permits the member to deploy. The dashboard shows the first-deploy entry point to members with an empty inventory and reserves the built-in demo actions for operators. [Workspace permissions](WORKSPACES_RBAC.md#-2-role-hierarchy--permission-matrix)

The browser journey passed on the locally built onboarding candidate `sha256:0e55fb1675a8a2ba55e78f59f9447d643beae2d7662dca9edd02bfa64af6241e`. The member's deployment reached `running` with the regular Docker image wizard. A dashboard regression test first reproduced the visible demo action for a non-operator and then passed with the permission-aware rendering. The focused runs passed 122 web tests, 40 server tests, and three browser journeys covering setup, first deploy, and member access.

```bash
docker build -t ninedeploy:member-onboarding .
node scripts/smoke-browser-e2e.mjs --image=ninedeploy:member-onboarding -- --project=desktop 02-first-deploy 07-member
```
