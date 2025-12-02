# Cloudflare Containers + R2-backed FUSE mounts

**Refer to the [public documentation](https://developers.cloudflare.com/r2/examples/fuse-on-r2/) for more information**

This is a demo app that shows how to mount an R2 bucket into a Cloudflare Container!

1. A Worker as the front-end that proxies to a single container instance
2. A container with an R2 bucket mounted using [tigrisfs](https://github.com/tigrisdata/tigrisfs) at `$HOME/mnt/r2/<bucket_name`>
3. A Go application that uses `io/fs` to list files in the mounted R2 bucket and return them as JSON

Mounting object storage buckets as FUSE mounts allows applications to interact with the bucket as if it were a local filesystem: useful if you have apps that don't have native support for object storage (many!) and/or want to simplify operations.

The trade-off is that object storage is not exactly a POSIX compatible filesystem, nor is it local, and so you should not expect native, SSD-like performance. For many apps, this doesn't matter: reading a bunch of shared assets, bootstrapping a agent/sandbox, or providing a way to persist user-state are all common use cases and rarely I/O intensive.

## Deploying it

You'll need to provide your [R2 API credentials](https://developers.cloudflare.com/r2/api/tokens/) and Cloudflare account ID to the container.

1. Update `wrangler.jsonc` with the `BUCKET_NAME` and `ACCOUNT_ID` environment variables. These are OK to be public.
2. Use `npx wrangler@latest secret put AWS_ACCESS_KEY_ID` and `npx wrangler@latest secret put AWS_SECRET_ACCESS_KEY` to set your R2 credentials.
3. Ensure Docker is running locally.
4. `npx wrangler@latest deploy`

You can mount multiple buckets as you wish by updating the Dockerfile or doing it dynamically from within the application in your container.

To mount a bucket at a specific prefix, set the `R2_BUCKET_PREFIX` environment variable in `wrangler.json` or dynamically when creating a container instance.

## Learn More

To learn more about Containers, take a look at the following resources:

- [Container Documentation](https://developers.cloudflare.com/containers/) - learn about Containers
- [Container Class](https://github.com/cloudflare/containers) - learn about the Container helper class
- Learn more about Container [lifecycles](https://developers.cloudflare.com/containers/platform-details/architecture/)

## License

Apache-2.0 licensed. Copyright 2025, Cloudflare, Inc.
