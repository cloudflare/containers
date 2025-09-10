# Contributing

Thanks for being interested in contributing to @cloudflare/containers!

## Developing

1. Clone the repo and install dependencies with `npm i`
2. The code for the Container class is in `src/lib`, primarily in `container.ts`. You can use `examples` to test your changes, either locally by running `npx wrangler dev`, which will automatically pick up changes to `src/lib`, or by deploying your container with `npx wrangler deploy`.
3. Add tests (located in `examples`) and run tests with `npm run test`.
4. If your PR will make user-impacting changes, you can add a `patch` changeset by running `npx changesets@cli`. This will ensure your change is included in our changelog.
