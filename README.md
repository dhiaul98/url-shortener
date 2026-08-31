# Linkora URL Shortener

Linkora is a responsive, self-hosted URL shortener designed to run as multiple stateless application replicas backed by PostgreSQL.

## Architecture

```text
Cloudflare Tunnel → Traefik/Ingress → app replica 1 ┐
                                  → app replica 2 ├→ PostgreSQL
                                  → app replica N ┘
```

All links, click counters, and creation rate limits are shared in PostgreSQL. App containers do not keep required state locally, so any replica can handle any request. Click counters use 64 database shards per popular link to avoid a single-row write bottleneck while keeping exact totals.

## Docker Compose

Copy the configuration and choose a strong database password:

```sh
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env
# Edit SHORTENER_HOST and POSTGRES_PASSWORD in .env.
docker compose up -d --build
```

The default configuration starts two app replicas. Scale them without downtime:

```sh
docker compose up -d --scale url-shortener=4
```

Traefik discovers every replica and load-balances requests across them. The URL shortener route intentionally has no basic-auth middleware. PostgreSQL is isolated on an internal Docker network and stores data in the `postgres_data` volume.

The first PostgreSQL startup automatically imports the old `links.json` records from the legacy Docker volume. The import uses a database lock and marker, making it safe when multiple replicas start together.

Useful operations:

```sh
docker compose ps
docker compose logs -f url-shortener
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "TABLE link_stats;"'
curl https://short.example.com/ready
```

Keep possible database connections below PostgreSQL's configured limit:

```text
maximum connections ≈ replica count × DB_POOL_MAX
```

## Kubernetes

The `k8s/` directory contains:

- A two-replica app Deployment
- A ClusterIP Service and Traefik Ingress
- Liveness and database-aware readiness probes
- A HorizontalPodAutoscaler from 2–10 replicas
- A PodDisruptionBudget
- An optional single-node PostgreSQL StatefulSet with persistent storage

Before deploying, publish the image, update `image:` in `k8s/app.yaml`, and replace `short.example.com` with your hostname:

```sh
docker build -t registry.example.com/linkora-url-shortener:1.0.0 .
docker push registry.example.com/linkora-url-shortener:1.0.0
```

Create the Kubernetes secret without committing it:

```sh
cp k8s/secret.example.yaml k8s/secret.yaml
# Edit both CHANGE_ME values in k8s/secret.yaml.
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -k k8s/
```

Scale manually:

```sh
kubectl -n linkora scale deployment/url-shortener --replicas=5
```

The HPA requires Kubernetes Metrics Server. For production, replace the included single-node PostgreSQL StatefulSet with managed or highly available PostgreSQL and change `DATABASE_URL` in the secret. Scaling app pods does not make a single PostgreSQL pod highly available.

## Endpoints

- `GET /health` — process liveness; does not depend on PostgreSQL
- `GET /ready` — readiness; succeeds only when PostgreSQL is reachable
- `POST /api/links` — create a short link
- `GET /:slug` — atomically count the click and redirect

Link creation is public and globally limited through PostgreSQL to 20 attempts per minute per client IP, regardless of the number of app replicas.
