const path = require('path');
const fs = require('fs');
const { PassThrough } = require('stream');
const ns = require('node-stream');
const unstyle = require('unstyle');
const touch = require('touch');
const symlink = require('symlink-dir');
const { expect } = require('chai');

// TODO api should accept this value
process.env.ELECTRONMON_LOGLEVEL = 'verbose';

const api = require('../');

describe('api', () => {
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

  function runTests(realRoot, cwd) {
    let app;

    const file = fixturename => {
      return path.resolve(realRoot, fixturename);
    };

    afterEach(async () => {
      if (!app) {
        return;
      }

      await app.stop();
      app = null;
    });

    it('watches files for restarts or refreshes', async () => {
      const pass = new PassThrough();
      app = await api({
        // NOTE: the API should always use realPath
        cwd: fs.realpathSync(cwd),
        args: ['main.js'],
        stdio: [process.stdin, pass, process.stderr]
      });

      const stdout = collect(wrap(pass));

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
        const pass = new PassThrough();
        app = await api({
          cwd,
          args: ['main.js'],
          env: { TEST_ERROR: 'pineapples' },
          stdio: [process.stdin, pass, process.stderr]
        });

        const stdout = collect(wrap(pass));

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
        const pass = new PassThrough();
        app = await api({
          cwd,
          args: ['main.js'],
          env: { TEST_ERROR: 'pineapples' },
          stdio: [process.stdin, pass, process.stderr]
        });

        const stdout = collect(wrap(pass));

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

  describe('when running the app from project directory', () => {
    const root = path.resolve(__dirname, '../fixtures');
    runTests(root, root);
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

    runTests(root, linkDir);
  });
});
