export const cases = [
  {
    "image": "ghcr.io/acme/app__one--two.v3:v1_2.3-4",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme/../../outside:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme//app:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/./app:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/-app:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/.app:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app_:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/a___b:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/a..b:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme/:v1",
    "valid": false,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app_v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app__v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app-v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app--v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/app.v2:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme/deep/web:v1",
    "valid": true,
    "kind": "repo"
  },
  {
    "image": "ghcr.io/acme/web:_valid",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:_",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:9",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:a.b-c_d",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "valid": true,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:..",
    "valid": false,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:-bad",
    "valid": false,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:.bad",
    "valid": false,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "valid": false,
    "kind": "tag"
  },
  {
    "image": "ghcr.io/acme/web:",
    "valid": false,
    "kind": "tag"
  }
] as const;
