/**
 * A1 step 1 fixtures: API responses of Coolify v4.7.0 (eaaaf7a7), Dokploy
 * v0.31.0 (3ac1c8f2) and CapRover v1.16.0 (74a61ff2).
 *
 * DERIVED FROM SOURCE, NOT CAPTURED FROM A LIVE INSTANCE: the field names and
 * shapes were read from each project's code at the pinned commit (routes,
 * serializers, drizzle schema, app-definition models). They prove the
 * adapters agree with that reading, not that they work against a real panel.
 *
 * Every field that carries a secret in the real API holds SENTINEL, so the
 * tests can prove no secret reaches a plan or its printed form.
 */
export const SENTINEL = 'S3NT1N3L-do-not-leak';

export const coolify: Record<string, unknown> = {
  '/api/v1/version': '4.7.0',
  '/api/v1/applications': [
    {
      uuid: 'app-git', name: 'shop-api', build_pack: 'dockerfile', git_repository: 'acme/shop-api', git_branch: 'main',
      git_full_url: `https://deploy:${SENTINEL}@github.com/acme/shop-api.git`, base_directory: '/api', dockerfile_location: '/Dockerfile.prod',
      fqdn: 'https://api.shop.example,http://api-old.shop.example', ports_exposes: '3000,9229', ports_mappings: '9000:3000',
      health_check_enabled: true, health_check_path: '/health', limits_memory: '512m', limits_cpus: '1.5',
      source_type: 'App\\Models\\GithubApp', private_key_id: null, status: 'running:healthy',
    },
    { uuid: 'app-img', name: 'docs', build_pack: 'dockerimage', docker_registry_image_name: 'nginx', docker_registry_image_tag: '1.27-alpine', fqdn: 'https://docs.example', ports_exposes: '80', limits_memory: '0', limits_cpus: '0' },
    { uuid: 'app-compose', name: 'stack-from-repo', build_pack: 'dockercompose', git_repository: 'https://gitlab.example/acme/stack.git', git_branch: 'prod', docker_compose_location: '/compose.prod.yml', fqdn: '' },
    { uuid: 'app-odd', name: 'odd', build_pack: 'heroku', git_repository: 'https://git.example/odd.git', git_branch: 'main', ports_exposes: 'x' },
  ],
  '/api/v1/applications/app-git/envs': [
    { key: 'DATABASE_URL', value: SENTINEL, real_value: SENTINEL, is_preview: false },
    { key: 'DATABASE_URL', value: SENTINEL, is_preview: true },
    { key: 'PREVIEW_ONLY', value: SENTINEL, is_preview: true },
    { key: 'NODE_ENV', value: 'production', is_preview: false },
  ],
  '/api/v1/applications/app-git/storages': {
    persistent_storages: [{ name: 'shop-uploads', mount_path: '/app/uploads', host_path: null }, { name: 'shop-cache', mount_path: '/app/cache' }],
    file_storages: [{ fs_path: '/data/x', mount_path: '/app/config.json', content: SENTINEL }],
  },
  '/api/v1/applications/app-img/envs': [],
  '/api/v1/applications/app-img/storages': { persistent_storages: [], file_storages: [] },
  '/api/v1/applications/app-compose/envs': [{ key: 'STACK_TOKEN', value: SENTINEL }],
  '/api/v1/applications/app-odd/envs': [],
  '/api/v1/applications/app-odd/storages': { persistent_storages: [], file_storages: [] },
  '/api/v1/services': [{ uuid: 'svc-1', name: 'plausible', service_type: 'plausible', docker_compose_raw: SENTINEL }],
  '/api/v1/services/svc-1': { uuid: 'svc-1', applications: [{ name: 'plausible', fqdn: 'https://stats.example' }], databases: [] },
  '/api/v1/services/svc-1/envs': [{ key: 'SECRET_KEY_BASE', value: SENTINEL }],
  '/api/v1/databases': [
    { uuid: 'db-pg', name: 'shop-db', database_type: 'standalone-postgresql', image: 'postgres:16-alpine', postgres_password: SENTINEL, is_public: true },
    { uuid: 'db-keydb', name: 'cache', database_type: 'standalone-keydb', image: 'eqalpha/keydb:latest', keydb_password: SENTINEL },
    { uuid: 'db-sqlite', name: 'tiny', database_type: 'standalone-sqlite', image: null },
  ],
};

export const dokploy: Record<string, unknown> = {
  '/api/settings.getDokployVersion': 'v0.31.0',
  '/api/project.all': [
    {
      projectId: 'p1', name: 'acme',
      environments: [{
        environmentId: 'e1', name: 'production',
        applications: [{ applicationId: 'a-gh', name: 'web' }, { applicationId: 'a-img', name: 'worker' }, { applicationId: 'a-drop', name: 'legacy' }, { applicationId: 'a-git', name: 'internal' }],
        compose: [{ composeId: 'c-raw', name: 'monitoring' }, { composeId: 'c-gh', name: 'mail' }],
        postgres: [{ postgresId: 'pg1', name: 'main-db' }],
        mysql: [], mariadb: [], mongo: [{ mongoId: 'mg1', name: 'events' }], redis: [{ redisId: 'rd1', name: 'cache' }], libsql: [{ libsqlId: 'ls1', name: 'edge' }],
      }],
    },
  ],
  '/api/application.one?applicationId=a-gh': {
    applicationId: 'a-gh', name: 'web', appName: 'web-x1', sourceType: 'github', owner: 'acme', repository: 'web', branch: 'main',
    buildType: 'heroku_buildpacks', buildPath: '/', env: `NODE_ENV=production\nSTRIPE_KEY=${SENTINEL}\n# comment\nexport API_URL=https://api\n`,
    memoryLimit: '1073741824', cpuLimit: '500000000', replicas: 3, command: null,
    domains: [{ host: 'acme.example', https: true, port: 3000 }, { host: 'www.acme.example', https: true, port: 3000 }],
    ports: [], mounts: [{ type: 'volume', volumeName: 'web-data', mountPath: '/data' }],
  },
  '/api/application.one?applicationId=a-img': {
    applicationId: 'a-img', name: 'worker', sourceType: 'docker', dockerImage: 'ghcr.io/acme/worker:2.1', username: 'acme', password: SENTINEL, registryUrl: 'ghcr.io',
    env: `QUEUE_TOKEN=${SENTINEL}`, replicas: 14, domains: [], ports: [{ publishedPort: 9000, targetPort: 9000 }], mounts: [], command: 'node worker.js',
  },
  '/api/application.one?applicationId=a-drop': { applicationId: 'a-drop', name: 'legacy', sourceType: 'drop', env: '', domains: [], ports: [], mounts: [] },
  '/api/application.one?applicationId=a-git': {
    applicationId: 'a-git', name: 'internal', sourceType: 'git', customGitUrl: `https://bot:${SENTINEL}@git.acme.example/internal.git`, customGitBranch: 'release',
    customGitBuildPath: '/svc', buildType: 'dockerfile', dockerfile: './Dockerfile', env: '', domains: [{ host: 'internal.acme.example', https: false, port: 8080 }], ports: [], mounts: [],
  },
  '/api/compose.one?composeId=c-raw': { composeId: 'c-raw', name: 'monitoring', sourceType: 'raw', composeFile: `services:\n  x:\n    environment:\n      - TOKEN=${SENTINEL}\n`, composeType: 'docker-compose', env: '', domains: [{ host: 'grafana.acme.example', https: true }], mounts: [] },
  '/api/compose.one?composeId=c-gh': { composeId: 'c-gh', name: 'mail', sourceType: 'github', owner: 'acme', repository: 'mail', branch: 'main', composePath: './compose.yml', composeType: 'stack', env: `SMTP_PASS=${SENTINEL}`, domains: [], mounts: [{ type: 'bind', hostPath: '/srv/mail', mountPath: '/var/mail' }] },
  '/api/postgres.one?postgresId=pg1': { postgresId: 'pg1', name: 'main-db', appName: 'main-db-a1b2', dockerImage: 'postgres:16', databasePassword: SENTINEL, externalPort: 5433 },
  '/api/mongo.one?mongoId=mg1': { mongoId: 'mg1', name: 'events', dockerImage: 'mongo:8', databasePassword: SENTINEL, externalPort: null },
  '/api/redis.one?redisId=rd1': { redisId: 'rd1', name: 'cache', dockerImage: 'redis:7', databasePassword: SENTINEL },
  '/api/libsql.one?libsqlId=ls1': { libsqlId: 'ls1', name: 'edge', dockerImage: 'ghcr.io/tursodatabase/libsql-server' },
};

export const caprover: Record<string, unknown> = {
  '/api/v2/user/system/info/': { rootDomain: 'apps.acme.example', captainSubDomain: 'captain', forceSsl: false },
  '/api/v2/user/system/versionInfo/': { currentVersion: '1.16.0', latestVersion: '1.16.0', changeLogMessage: '', canUpdate: false },
  '/api/v2/user/apps/appDefinitions/': {
    rootDomain: 'apps.acme.example',
    appDefinitions: [
      {
        appName: 'blog', instanceCount: 2, containerHttpPort: 2368, hasDefaultSubDomainSsl: true, notExposeAsWebApp: false,
        customDomain: [{ publicDomain: 'blog.acme.example', hasSsl: true }], envVars: [{ key: 'DB_PASSWORD', value: SENTINEL }, { key: 'url', value: 'https://blog' }],
        volumes: [{ containerPath: '/var/lib/ghost/content', volumeName: 'blog-content' }], ports: [], deployedVersion: 3,
        versions: [{ version: 3, deployedImageName: 'img-captain-blog:3', timeStamp: 'x', gitHash: 'abc' }],
        appPushWebhook: { pushWebhookToken: SENTINEL, repoInfo: { repo: `https://ci:${SENTINEL}@github.com/acme/blog.git`, branch: 'main', user: 'ci', password: SENTINEL, sshKey: SENTINEL } },
        appDeployTokenConfig: { enabled: true, appDeployToken: SENTINEL }, httpAuth: { user: 'admin', passwordHashed: SENTINEL },
        customNginxConfig: 'location / {}', tags: [],
      },
      { appName: 'proxy', instanceCount: 1, containerHttpPort: 80, notExposeAsWebApp: false, hasDefaultSubDomainSsl: false, customDomain: [], envVars: [], volumes: [], ports: [{ hostPort: 8443, containerPort: 443 }], deployedVersion: 1, versions: [{ version: 1, deployedImageName: 'traefik/whoami:v1.10.3' }], tags: [] },
      { appName: 'uploaded', instanceCount: 1, containerHttpPort: 3000, notExposeAsWebApp: true, envVars: [], volumes: [], ports: [], deployedVersion: 0, versions: [{ version: 0, deployedImageName: 'captain.localhost:996/captain/img-captain-uploaded:0' }], tags: [] },
      { appName: 'pg', instanceCount: 1, notExposeAsWebApp: true, envVars: [{ key: 'POSTGRES_PASSWORD', value: SENTINEL }], volumes: [{ containerPath: '/var/lib/postgresql/data', volumeName: 'pg-data' }], ports: [{ hostPort: 5432, containerPort: 5432 }], deployedVersion: 0, versions: [{ version: 0, deployedImageName: 'postgres:14.5' }], tags: [{ tagName: 'postgres' }] },
    ],
  },
};

/**
 * CAPTURED LIVE from CapRover v1.16.0 (caprover/caprover:1.16.0 in a disposable
 * dind, 2026-11-09): the appDefinitions, system/info and versionInfo responses
 * after registering three apps through the API. Only secret values were
 * replaced with SENTINEL (env values, the Git password, the push-webhook token)
 * and defaultNginxConfig was dropped. Notable live shapes: system/info returns
 * rootDomain "", a registered app runs caprover/caprover-placeholder-app until
 * its first deploy, and an update without instanceCount leaves it at 0.
 */
export const caproverLive: Record<string, unknown> = {
  "/api/v2/user/system/info/": {
    "forceSsl": false,
    "rootDomain": "",
    "captainSubDomain": "captain"
  },
  "/api/v2/user/system/versionInfo/": {
    "currentVersion": "1.16.0",
    "latestVersion": "1.16.0",
    "changeLogMessage": "",
    "canUpdate": false
  },
  "/api/v2/user/apps/appDefinitions/": {
    "appDefinitions": [
      {
        "hasPersistentData": true,
        "projectId": "",
        "description": "",
        "instanceCount": 2,
        "captainDefinitionRelativeFilePath": "./captain-definition",
        "networks": [
          "captain-overlay-network"
        ],
        "envVars": [
          {
            "key": "DB_PASSWORD",
            "value": SENTINEL
          },
          {
            "key": "url",
            "value": "https://blog"
          }
        ],
        "volumes": [
          {
            "containerPath": "/var/lib/ghost/content",
            "volumeName": "blog-content"
          }
        ],
        "ports": [],
        "tags": [],
        "versions": [
          {
            "version": 0,
            "timeStamp": "2026-11-09T22:41:28.738Z",
            "deployedImageName": "caprover/caprover-placeholder-app:latest",
            "gitHash": ""
          }
        ],
        "deployedVersion": 0,
        "notExposeAsWebApp": false,
        "customDomain": [],
        "hasDefaultSubDomainSsl": false,
        "redirectDomain": "",
        "forceSsl": false,
        "websocketSupport": false,
        "appPushWebhook": {
          "tokenVersion": SENTINEL,
          "pushWebhookToken": SENTINEL,
          "repoInfo": {
            "repo": `https://ci:${SENTINEL}@github.com/acme/blog.git`,
            "user": "ci",
            "password": SENTINEL,
            "sshKey": "",
            "branch": "main"
          }
        },
        "containerHttpPort": 2368,
        "nodeId": "5xrc0s0xof6cf2bnvorc5p5s5",
        "customNginxConfig": "",
        "preDeployFunction": "",
        "serviceUpdateOverride": "",
        "appDeployTokenConfig": {
          "enabled": false
        },
        "appName": "blog",
        "isAppBuilding": false,
        "isLegacyAppName": false
      },
      {
        "hasPersistentData": false,
        "projectId": "",
        "description": "",
        "instanceCount": 0,
        "captainDefinitionRelativeFilePath": "./captain-definition",
        "networks": [
          "captain-overlay-network"
        ],
        "envVars": [],
        "volumes": [],
        "ports": [
          {
            "hostPort": 8443,
            "containerPort": 443
          }
        ],
        "tags": [],
        "versions": [
          {
            "version": 0,
            "timeStamp": "2026-11-09T22:41:34.363Z",
            "deployedImageName": "caprover/caprover-placeholder-app:latest",
            "gitHash": ""
          },
          {
            "version": 1,
            "timeStamp": "2026-11-09T22:41:39.971Z",
            "deployedImageName": "traefik/whoami:v1.10.3",
            "gitHash": ""
          }
        ],
        "deployedVersion": 1,
        "notExposeAsWebApp": false,
        "customDomain": [],
        "hasDefaultSubDomainSsl": false,
        "redirectDomain": "",
        "forceSsl": false,
        "websocketSupport": false,
        "containerHttpPort": 80,
        "nodeId": "",
        "customNginxConfig": "",
        "preDeployFunction": "",
        "serviceUpdateOverride": "",
        "appDeployTokenConfig": {
          "enabled": false
        },
        "appName": "proxy",
        "isAppBuilding": false,
        "isLegacyAppName": false
      },
      {
        "hasPersistentData": true,
        "projectId": "",
        "description": "",
        "instanceCount": 0,
        "captainDefinitionRelativeFilePath": "./captain-definition",
        "networks": [
          "captain-overlay-network"
        ],
        "envVars": [
          {
            "key": "POSTGRES_PASSWORD",
            "value": SENTINEL
          }
        ],
        "volumes": [
          {
            "containerPath": "/var/lib/postgresql/data",
            "volumeName": "pg-data"
          }
        ],
        "ports": [],
        "tags": [
          {
            "tagName": "postgres"
          }
        ],
        "versions": [
          {
            "version": 0,
            "timeStamp": "2026-11-09T22:41:45.437Z",
            "deployedImageName": "caprover/caprover-placeholder-app:latest",
            "gitHash": ""
          }
        ],
        "deployedVersion": 0,
        "notExposeAsWebApp": false,
        "customDomain": [],
        "hasDefaultSubDomainSsl": false,
        "redirectDomain": "",
        "forceSsl": false,
        "websocketSupport": false,
        "containerHttpPort": 80,
        "nodeId": "5xrc0s0xof6cf2bnvorc5p5s5",
        "customNginxConfig": "",
        "preDeployFunction": "",
        "serviceUpdateOverride": "",
        "appDeployTokenConfig": {
          "enabled": false
        },
        "appName": "pg",
        "isAppBuilding": false,
        "isLegacyAppName": false
      }
    ],
    "rootDomain": "captain.localhost",
    "captainSubDomain": "captain"
  }
};

/**
 * CAPTURED LIVE from Dokploy v0.31.0 (dokploy/dokploy:v0.31.0 set up the way
 * its install.sh does, in a disposable dind, 2026-11-11): the
 * getDokployVersion, project.all, application.one and postgres.one responses after creating
 * a project with an image application (env, domain, volume mount) and a
 * PostgreSQL 16 database through the API. Every value of a token, password,
 * secret or key field, and every env value, was replaced with SENTINEL.
 * Notable live facts: a default API key is rate-limited (10 a day; refused
 * after 5 calls here), applications and databases run as Swarm services named
 * after their appName, and a volume mount's Docker volume is its volumeName.
 */
export const DOKPLOY_LIVE_APP_ID = "fxJQnCYQaa8obs5vWsj_5";
export const dokployLive: Record<string, unknown> = {
  "/api/settings.getDokployVersion": "v0.31.0",
  "/api/project.all": [
    {
      "projectId": "9tkIthNhmTJsNd8ZEc888",
      "name": "shop",
      "description": "A1 live check",
      "createdAt": "2026-11-11T01:04:22.595Z",
      "organizationId": "e41w1r_nisOSQevc2G-gk",
      "env": "",
      "environments": [
        {
          "name": "production",
          "environmentId": "WVs58QZVKIrvVwMk5Qsi0",
          "isDefault": true,
          "applications": [
            {
              "applicationId": "fxJQnCYQaa8obs5vWsj_5",
              "name": "web",
              "applicationStatus": "idle"
            }
          ],
          "mariadb": [],
          "mongo": [],
          "mysql": [],
          "postgres": [
            {
              "postgresId": "j54MKN1Eu7EZp4COfZN5y"
            }
          ],
          "redis": [],
          "compose": [],
          "libsql": []
        }
      ],
      "projectTags": []
    }
  ],
  "/api/application.one?applicationId=fxJQnCYQaa8obs5vWsj_5": {
    "applicationId": "fxJQnCYQaa8obs5vWsj_5",
    "name": "web",
    "appName": "app-input-haptic-driver-jff7nq",
    "description": null,
    "env": `APP_MODE=${SENTINEL}\nAPI_SECRET=${SENTINEL}`,
    "previewEnv": null,
    "watchPaths": null,
    "previewBuildArgs": null,
    "previewBuildSecrets": null,
    "previewLabels": null,
    "previewWildcard": null,
    "previewPort": 3000,
    "previewHttps": false,
    "previewPath": "/",
    "previewCertificateType": "none",
    "previewCustomCertResolver": null,
    "previewLimit": 3,
    "isPreviewDeploymentsActive": false,
    "previewRequireCollaboratorPermissions": true,
    "rollbackActive": false,
    "buildArgs": "",
    "buildSecrets": "",
    "memoryReservation": null,
    "memoryLimit": null,
    "cpuReservation": null,
    "cpuLimit": null,
    "title": null,
    "enabled": null,
    "subtitle": null,
    "command": null,
    "args": null,
    "icon": null,
    "refreshToken": SENTINEL,
    "sourceType": "docker",
    "cleanCache": false,
    "repository": null,
    "owner": null,
    "branch": null,
    "buildPath": "/",
    "triggerType": "push",
    "autoDeploy": true,
    "gitlabProjectId": null,
    "gitlabRepository": null,
    "gitlabOwner": null,
    "gitlabBranch": null,
    "gitlabBuildPath": "/",
    "gitlabPathNamespace": null,
    "giteaRepository": null,
    "giteaOwner": null,
    "giteaBranch": null,
    "giteaBuildPath": "/",
    "bitbucketRepository": null,
    "bitbucketRepositorySlug": null,
    "bitbucketOwner": null,
    "bitbucketBranch": null,
    "bitbucketBuildPath": "/",
    "username": null,
    "password": null,
    "dockerImage": "nginx:1.27-alpine",
    "registryUrl": null,
    "customGitUrl": null,
    "customGitBranch": null,
    "customGitBuildPath": null,
    "customGitSSHKeyId": null,
    "enableSubmodules": false,
    "dockerfile": "Dockerfile",
    "dockerContextPath": null,
    "dockerBuildStage": null,
    "dropBuildPath": null,
    "healthCheckSwarm": null,
    "restartPolicySwarm": null,
    "placementSwarm": null,
    "updateConfigSwarm": null,
    "rollbackConfigSwarm": null,
    "modeSwarm": null,
    "labelsSwarm": null,
    "networkSwarm": null,
    "stopGracePeriodSwarm": null,
    "endpointSpecSwarm": null,
    "ulimitsSwarm": null,
    "replicas": 1,
    "applicationStatus": "idle",
    "buildType": "nixpacks",
    "railpackVersion": "0.15.4",
    "herokuVersion": "24",
    "publishDirectory": null,
    "isStaticSpa": null,
    "createEnvFile": false,
    "createdAt": "2026-11-11T01:04:22.692Z",
    "registryId": null,
    "rollbackRegistryId": null,
    "environmentId": "WVs58QZVKIrvVwMk5Qsi0",
    "githubId": null,
    "gitlabId": null,
    "giteaId": null,
    "bitbucketId": null,
    "serverId": null,
    "buildServerId": null,
    "buildRegistryId": null,
    "networkIds": [],
    "detachDokployNetwork": false,
    "environment": {
      "environmentId": "WVs58QZVKIrvVwMk5Qsi0",
      "name": "production",
      "description": "Production environment",
      "createdAt": "2026-11-11T01:04:22.598Z",
      "env": "",
      "projectId": "9tkIthNhmTJsNd8ZEc888",
      "isDefault": true,
      "project": {
        "projectId": "9tkIthNhmTJsNd8ZEc888",
        "name": "shop",
        "description": "A1 live check",
        "createdAt": "2026-11-11T01:04:22.595Z",
        "organizationId": "e41w1r_nisOSQevc2G-gk",
        "env": ""
      }
    },
    "domains": [
      {
        "domainId": "HDzGQ5zzbmBf6v9gd23U7",
        "host": "shop.example.com",
        "https": true,
        "port": 80,
        "customEntrypoint": null,
        "path": "/",
        "serviceName": null,
        "domainType": "application",
        "uniqueConfigKey": 1,
        "createdAt": "2026-11-11T01:04:22.848Z",
        "composeId": null,
        "customCertResolver": null,
        "applicationId": "fxJQnCYQaa8obs5vWsj_5",
        "previewDeploymentId": null,
        "certificateType": "letsencrypt",
        "internalPath": "/",
        "stripPath": false,
        "middlewares": [],
        "forwardAuthEnabled": false,
        "enabled": true
      }
    ],
    "deployments": [],
    "mounts": [
      {
        "mountId": "vCsHQQJERdMlqJs7mV2oG",
        "type": "volume",
        "hostPath": null,
        "volumeName": "web-html",
        "filePath": null,
        "content": null,
        "serviceType": "application",
        "mountPath": "/usr/share/nginx/html",
        "applicationId": "fxJQnCYQaa8obs5vWsj_5",
        "composeId": null,
        "libsqlId": null,
        "mariadbId": null,
        "mongoId": null,
        "mysqlId": null,
        "postgresId": null,
        "redisId": null
      }
    ],
    "redirects": [],
    "security": [],
    "ports": [],
    "gitlab": null,
    "github": null,
    "bitbucket": null,
    "gitea": null,
    "server": null,
    "previewDeployments": [],
    "registry": null,
    "buildRegistry": null,
    "rollbackRegistry": null,
    "hasGitProviderAccess": true,
    "unauthorizedProvider": null
  },
  "/api/postgres.one?postgresId=j54MKN1Eu7EZp4COfZN5y": {
    "postgresId": "j54MKN1Eu7EZp4COfZN5y",
    "name": "orders",
    "appName": "postgres-input-digital-array-t7b1r7",
    "databaseName": "orders",
    "databaseUser": "shop",
    "databasePassword": SENTINEL,
    "description": null,
    "dockerImage": "postgres:16",
    "command": null,
    "args": null,
    "env": null,
    "memoryReservation": null,
    "externalPort": null,
    "memoryLimit": null,
    "cpuReservation": null,
    "cpuLimit": null,
    "applicationStatus": "done",
    "healthCheckSwarm": null,
    "restartPolicySwarm": null,
    "placementSwarm": null,
    "updateConfigSwarm": null,
    "rollbackConfigSwarm": null,
    "modeSwarm": null,
    "labelsSwarm": null,
    "networkSwarm": null,
    "stopGracePeriodSwarm": null,
    "endpointSpecSwarm": null,
    "ulimitsSwarm": null,
    "replicas": 1,
    "createdAt": "2026-11-11T01:04:54.371Z",
    "environmentId": "WVs58QZVKIrvVwMk5Qsi0",
    "serverId": null,
    "networkIds": [],
    "detachDokployNetwork": false,
    "environment": {
      "environmentId": "WVs58QZVKIrvVwMk5Qsi0",
      "name": "production",
      "description": "Production environment",
      "createdAt": "2026-11-11T01:04:22.598Z",
      "env": "",
      "projectId": "9tkIthNhmTJsNd8ZEc888",
      "isDefault": true,
      "project": {
        "projectId": "9tkIthNhmTJsNd8ZEc888",
        "name": "shop",
        "description": "A1 live check",
        "createdAt": "2026-11-11T01:04:22.595Z",
        "organizationId": "e41w1r_nisOSQevc2G-gk",
        "env": ""
      }
    },
    "mounts": [
      {
        "mountId": "eOz43katuWL7rgALnplza",
        "type": "volume",
        "hostPath": null,
        "volumeName": "postgres-input-digital-array-t7b1r7-data",
        "filePath": null,
        "content": null,
        "serviceType": "postgres",
        "mountPath": "/var/lib/postgresql/data",
        "applicationId": null,
        "composeId": null,
        "libsqlId": null,
        "mariadbId": null,
        "mongoId": null,
        "mysqlId": null,
        "postgresId": "j54MKN1Eu7EZp4COfZN5y",
        "redisId": null
      }
    ],
    "server": null,
    "backups": []
  }
};
