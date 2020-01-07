const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const ns = require('node-stream');
const unstyle = require('unstyle');
const touch = require('touch');
const symlink = require('symlink-dir');
const { expect } = require('chai');

describe('integration', () => {
  const wrap = stream => {
    return stream
      .pipe(unstyle())
      .pipe(ns.split())
      .pipe(ns.map(s => s.trim()));
  };

  const collect = stream => {
    const lines = [];

    stream._getLines = () => [].concat(lines);
    stream.on('data', line => lines.push(line));
    stream.pause();

    return stream;
  };

  const waitFor = (stream, regex) => {
    return new Promise(resolve => {
      const onReadable = () => {
        stream.resume();
      };

      const onLine = line => {
        stream.pause();

        if (regex.test(line)) {
          stream.removeListener('readable', onReadable);
          stream.removeListener('data', onLine);
          return resolve();
        }

        stream.resume();
      };

      stream.on('readable', onReadable);
      stream.on('data', onLine);
      stream.resume();
    });
  };

  const ready = stream => {
    return Promise.all([
      waitFor(stream, /main window open/),
      waitFor(stream, /watching new file: main\.js/),
      waitFor(stream, /watching new file: renderer\.js/),
      waitFor(stream, /watching new file: index\.html/)
    ]);
  };

  function runIntegrationTests(realRoot, cwd, start) {
    let app;

    const file = fixturename => {
      return path.resolve(realRoot, fixturename);
    };

    it('watches files for restarts or refreshes', async () => {
      app = await start({
        args: ['main.js'],
        cwd,
        env: Object.assign({}, process.env, {
          ELECTRONMON_LOGLEVEL: 'verbose'
        })
      });

      const stdout = collect(wrap(app.stdout));

      await ready(stdout);

      await Promise.all([
        waitFor(stdout, /renderer file change: index\.html/),
        touch(file('index.html'))
      ]);

      await Promise.all([
        waitFor(stdout, /renderer file change: renderer\.js/),
        touch(file('renderer.js'))
      ]);

      await Promise.all([
        waitFor(stdout, /main file change: main\.js/),
        waitFor(stdout, /restarting app due to file change/),
        waitFor(stdout, /main window open/),
        touch(file('main.js'))
      ]);
    });

    if (process.platform === 'win32') {
      it('restarts apps on a change after they crash and the dialog is still open', async () => {
        app = await start({
          args: ['main.js'],
          cwd,
          env: Object.assign({}, process.env, {
            ELECTRONMON_LOGLEVEL: 'verbose',
            TEST_ERROR: 'pineapples'
          })
        });

        const stdout = collect(wrap(app.stdout));

        await waitFor(stdout, /pineapples/);
        await waitFor(stdout, /waiting for any change to restart the app/);

        await Promise.all([
          waitFor(stdout, /file change: main\.js/),
          waitFor(stdout, /pineapples/),
          waitFor(stdout, /waiting for any change to restart the app/),
          touch(file('main.js'))
        ]);

        await Promise.all([
          waitFor(stdout, /file change: renderer\.js/),
          waitFor(stdout, /pineapples/),
          waitFor(stdout, /waiting for any change to restart the app/),
          touch(file('renderer.js'))
        ]);
      });
    } else {
      it('restarts apps on a change after they crash at startup', async () => {
        app = await start({
          args: ['main.js'],
          cwd,
          env: Object.assign({}, process.env, {
            ELECTRONMON_LOGLEVEL: 'verbose',
            TEST_ERROR: 'pineapples'
          })
        });

        const stdout = collect(wrap(app.stdout));

        await waitFor(stdout, /uncaught exception occured/),
        await waitFor(stdout, /waiting for any change to restart the app/);

        await Promise.all([
          waitFor(stdout, /file change: main\.js/),
          waitFor(stdout, /uncaught exception occured/),
          waitFor(stdout, /waiting for any change to restart the app/),
          touch(file('main.js'))
        ]);

        await Promise.all([
          waitFor(stdout, /file change: renderer\.js/),
          waitFor(stdout, /uncaught exception occured/),
          waitFor(stdout, /waiting for any change to restart the app/),
          touch(file('renderer.js'))
        ]);
      });
    }
  }

  function runIntegrationSuite(start) {
    describe('when running the app from project directory', () => {
      const root = path.resolve(__dirname, '../fixtures');
      runIntegrationTests(root, root, start);
    });

    describe('when running the app from a linked directory', () => {
      const root = path.resolve(__dirname, '../fixtures');
      const linkDir = path.resolve(__dirname, '..', `fixtures-${Math.random().toString(36).slice(2)}`);

      before(async () => {
        await symlink(root, linkDir);
      });
      after((done) => {
        fs.unlink(linkDir, done);
      });

      it(`making sure link exists at ${linkDir}`, () => {
        const realPath = fs.realpathSync(linkDir);
        expect(realPath).to.equal(root);
      });

      runIntegrationTests(root, linkDir, start);
    });
  }

  describe('api', () => {
    const api = require('../');
    let app;

    afterEach(async () => {
      if (!app) {
        return;
      }

      await app.stop();
      app = null;
    });

    const start = async ({ args, cwd, env }) => {
      const pass = new PassThrough();
      app = await api({
        // NOTE: the API should always use realPath
        cwd: fs.realpathSync(cwd),
        args,
        env,
        stdio: [process.stdin, pass, pass],
        logLevel: env.ELECTRONMON_LOGLEVEL || 'verbose'
      });

      app.stdout = pass;

      return app;
    };

    runIntegrationSuite(start);
  });

  describe('cli', () => {
    const cli = path.resolve(__dirname, '../bin/cli.js');
    let app;

    afterEach(async () => {
      if (!app) {
        return;
      }

      const tmp = app;
      app = null;

      await new Promise(resolve => {
        tmp.once('exit', () => resolve());

        // destroying the io is necessary on linux and osx
        tmp.stdout.destroy();
        tmp.stderr.destroy();

        tmp.kill();
      });
    });

    const start = async ({ args, cwd, env }) => {
      app = spawn(process.execPath, [cli].concat(args), {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      return app;
    };

    runIntegrationSuite(start);
  });
});
