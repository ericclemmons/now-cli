import autoBind from 'auto-bind';
import chalk from 'chalk';
import { fork, spawn } from 'child_process';
import onDeath from 'death';
import { Server } from 'http';
import mime from 'mime-types';
import { dir } from 'tmp-promise';
import path from 'path';
import rawBody from 'raw-body';

import { npm as getNpmFiles } from '../../util/get-files';
import { readLocalConfig } from '../../util/config/files';
import createOutput from '../../util/output';

// Sure, this could be done in a "functional" way, but there is so
// much statefulness to it (e.g. `output`, tmp dir, processes, etc.)
// it's easier to encapsulate it in a class than have argument explosion.
export default class Dev {
  constructor({
    config = readLocalConfig(process.cwd()),
    debug = false,
    output = createOutput(),
  }) {
    this.artifacts = new Map();
    this.config = config;
    this.debug = debug;
    this.output = output;

    autoBind(this);
  }

  async cleanup() {
    this.output.print('\n');
    this.output.note(
      `Cleaning up ${this.workspace.path}... (Pass ${chalk.bold(
        '--debug'
      )} to keep)`
    );
    return this.workspace.cleanup();
  }

  async build() {
    const files = await this.getFiles();

    for (const build of this.config.builds) {
      const { src, use } = build;

      let builder;

      try {
        // ! Attempt to use the `dev` version of a builder
        const useDev = path.join(use, 'dev');
        const builderPath = this.resolve(useDev);

        this.output.log(`Initializing ${chalk.cyan(useDev)}...`);
        builder = this.require(builderPath);
      } catch (error) {
        // ! Until all builders can run their `build` locally,
        // we should prevent them from running.
        this.output.error(`${use} does not support "now dev"`);
        throw error;
        // ! After which, we can re-enable this functionality:
        // output.log(`Initializing ${chalk.cyan(use)}...`);
        // builder = this.require(use);
      }

      const entrypoints = await this.glob(src, process.cwd());

      for (const [entrypoint] of Object.entries(entrypoints)) {
        this.output.log(
          `Building ${chalk.bold(entrypoint)} with ${chalk.dim(use)}...`
        );

        const builderArtifacts = await builder.build({
          entrypoint,
          files,
          workPath: this.workspace.path,
        });

        // Track targets (string) to artifacts (lambda/fileref) from their builders
        for (const [target, artifact] of Object.entries(builderArtifacts)) {
          this.artifacts.set(target, artifact);
          this.output.log(`Built ${chalk.dim(target)}`);
        }
      }
    }
  }

  async createWorkspace() {
    // Create & switch to a clean working directory
    // (Costly, but "correct")
    this.workspace = await dir({ unsafeCleanup: true });

    this.output.note(`Created workspace at ${chalk.cyan(this.workspace.path)}`);

    // Ensure we cleanup on exit properly
    onDeath(async signal => {
      if (!this.debug) await this.cleanup();
      process.exit(signal);
    });

    return this.workspace;
  }

  async findNewPort(port = 4000) {
    return new Promise((resolve, reject) => {
      const server = new Server();

      server.on('error', err => {
        if (err.code !== 'EADDRINUSE') {
          return reject(err);
        }

        server.listen(++port);
      });

      server.on('listening', () => server.close(() => resolve(port)));

      server.listen(port);
    });
  }

  async getFiles() {
    const pkg = {}; // TODO Use package.json

    // When should this use `getStaticFiles`?
    const filePaths = await getNpmFiles(process.cwd(), pkg, this.config, {
      output: this.output,
    });

    // glob only works against relative paths
    const fileGlobs = filePaths.map(filePath =>
      filePath.replace(`${process.cwd()}/`, '')
    );

    // Map strings to the FileFsRef version of glob
    const fileEntries = await Promise.all(
      fileGlobs.map(fileGlob => this.glob(fileGlob, process.cwd()))
    );

    // Reduce all [{ entry: FileFsRef }] objects to a single Object.
    const files = fileEntries.reduce(
      (acc, entry) => ({
        ...acc,
        ...entry,
      }),
      {}
    );

    return files;
  }

  async glob(...args) {
    // This version of `glob` depends on these utils being installed,
    // and returns `FileFsRef`s.
    const glob = this.require('@now/build-utils/fs/glob');

    return glob(...args);
  }

  async handle(req, res) {
    const FileBlob = this.require('@now/build-utils/file-blob');
    const FileFsRef = this.require('@now/build-utils/file-fs-ref');

    // When no routes are defined, we default to 1-to-1 mappings
    const defaultRoutes = [
      {
        src: '/(.*)',
        dest: '/$1',
      },
      // Fallback to /index.*
      {
        src: '/',
        dest: '/index.html',
      },
      {
        src: '/',
        dest: '/index.js',
      },
    ];

    const { routes = defaultRoutes } = this.config;

    // Match request to the build artifact
    for (const route of routes) {
      // We can skip this route if it doesn't map to a destination
      if (!req.url.match(route.src)) {
        continue;
      }

      let target = req.url.replace(new RegExp(route.src), route.dest);

      this.output.debug(
        `Routing ${chalk.cyan(req.url)} to ${chalk.bold(target)}`
      );

      let artifact = this.artifacts.get(target);

      // Try target without a "/" prefix
      if (!artifact && target.charAt(0) === '/') {
        artifact = this.artifacts.get(target.slice(1));
      }

      // Skip this route
      if (!artifact) {
        continue;
      }

      this.output.log(`Serving ${chalk.bold(target)}...`);

      res.writeHead(200, {
        'Content-Type':
          mime.contentType(path.basename(target)) || 'text/html; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'X-Content-Type-Options': 'nosniff',
        ...route.headers,
      });

      if (artifact instanceof FileBlob || artifact instanceof FileFsRef) {
        return artifact.toStream().pipe(res);
      }

      // ! Temporary requirement of executing lambdas.
      if (typeof artifact !== 'function') {
        console.error(artifact);
        throw new Error(`Only functional lambdas are supported in dev.`);
      }

      const event = {
        host: req.headers.host,
        path: req.url,
        httpMethod: req.method,
        headers: req.headers,
        body: (await rawBody(req)).toString('utf8'),
      };

      const { body, encoding, headers, statusCode } = await artifact(event);

      res.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        ...headers,
      });

      if (encoding === 'base64') {
        res.write(Buffer.from(body, encoding));
      } else if (encoding === undefined) {
        res.write(Buffer.from(body));
      } else {
        throw new Error(`Unsupported encoding: ${encoding}`);
      }

      return res.end();
    }

    this.output.warn(`No artifact built for ${chalk.bold(req.url)}`);

    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'X-Content-Type-Options': 'nosniff',
    });

    res.write(`No routes match ${req.url}. Try refreshing.`);
    res.end();
  }

  async installBuilders() {
    const dependencies = [
      '@now/build-utils',
      ...this.config.builds.map(build => build.use),
    ];

    // Install all dependencies
    for (const dependency of dependencies) {
      // Attempt to find the dependency first, before installing...
      try {
        this.resolve(dependency);
        continue;
      } catch (error) {
        // Doesn't exist, keep installing it
      }

      const options = { cwd: this.workspace.path, stdio: 'ignore' };

      try {
        // Prefer linking local dependency over external dependency
        await this.spawn('yarn', ['link', dependency], options);
        this.output.log(`Linked ${chalk.bold(dependency)}...`);
      } catch (error) {
        // Does not exist locally, so install as usual
        try {
          this.output.log(`Installing ${chalk.bold(dependency)}...`);
          await this.spawn(
            'yarn',
            ['add', '--dev', '--prefer-offline', dependency],
            options
          );
        } catch (error) {
          this.output.error(error.message);
        }
      }
    }

    this.mockCreateLambda();
  }

  listen(port) {
    const server = new Server();

    server.on('request', this.handle);
    server.listen(port, () => {
      this.output.log(`🚀 Ready! http://localhost:${server.address().port}/`);
    });
  }

  mockCreateLambda() {
    const download = this.require('@now/build-utils/fs/download');
    const lambdaExports = this.require('@now/build-utils/lambda');
    const childProcesses = new Map();

    lambdaExports.createLambda = async ({
      files,
      handler,
      // runtime,
      environment = {},
    }) => {
      await download(files, this.workspace.path);

      const [launcherFile] = handler.split('.');

      // Close existing lambas
      if (childProcesses.has(handler)) {
        childProcesses.get(handler).disconnect();
        childProcesses.delete(handler);
      }

      const child = fork(launcherFile, [], {
        cwd: this.workspace.path,
        env: {
          ...environment,
          NODE_ENV: 'development',
          PORT: await this.findNewPort(),
        },
        execArgv: [],
      });

      // Store it so we can disconnect when replaced
      childProcesses.set(handler, child);

      return event =>
        new Promise(resolve => {
          child.send(event);
          child.on('message', resolve);
        });
    };
  }

  // Because `require.resolve` doesn't know of our tmp directory, we need to resolve dynamically
  require(moduleName) {
    return require(this.resolve(moduleName));
  }

  resolve(moduleName) {
    const modulePath = require.resolve(moduleName, {
      // Exclude all modules paths to avoid untracked dependencies
      paths: [this.workspace.path],
    });

    // Every time we resolve a file, we ensure it's not cached
    delete require.cache[modulePath];

    return modulePath;
  }

  spawn(command, args, options = { stdio: 'inherit' }) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, options);
      child.on('error', reject);
      child.on(
        'close',
        (code, signal) =>
          code !== 0
            ? reject(new Error(`Exited with ${code || signal}`))
            : resolve()
      );
    });
  }
}