# Ausstellungsdatenbank exporter


Will query all entities via GraphQL and produce triples, which can be exported on a per type base or as a whole corpora.

> This toolset exports all entities based on a json-schema to RDF within a given namespace


### Scripts

#### `npm run start`

Starts the app in production by first building the project with `npm run build`, and then executing the compiled JavaScript at `build/index.js`.

Will populate the `./out` folder with TURTLE files.

#### `npm run build`

Builds the app at `build`, cleaning the folder first.

#### `npm run test`

Runs the `jest` tests once.

#### `npm run test:dev`

Run the `jest` tests in watch mode, waiting for file changes.

#### `npm run prettier-format`

Format your code.

#### `npm run prettier-watch`

Format your code in watch mode, waiting for file changes.
