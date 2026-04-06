const path = require('path')
const webpack = require('webpack')

const rootDir = path.resolve(__dirname, '../..')
const shimDir = path.resolve(rootDir, 'src/js/shims')
const electronShim = path.resolve(rootDir, 'src/js/electron-shim.js')
const noopShim = path.resolve(shimDir, 'noop-shim.js')

module.exports = {
  entry: './src/js/web-entry.js',
  target: 'web',
  output: {
    path: path.resolve(rootDir, 'src/build'),
    filename: 'web-app.js'
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules\/(?!(electron-redux)\/).*/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              [
                '@babel/preset-env',
                {
                  targets: { browsers: ['last 2 Chrome versions'] }
                }
              ],
              '@babel/preset-react'
            ],
            plugins: [
              '@babel/plugin-proposal-class-properties',
              '@babel/plugin-proposal-optional-chaining'
            ]
          }
        }
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.(png|jpe?g|gif|svg|webp)$/i,
        use: [
          {
            loader: 'file-loader',
            options: {
              name: '[name].[hash:8].[ext]',
              outputPath: 'assets'
            }
          }
        ]
      },
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/,
        use: [
          {
            loader: 'file-loader',
            options: {
              name: '[name].[hash:8].[ext]',
              outputPath: 'fonts'
            }
          }
        ]
      }
    ]
  },
  resolve: {
    alias: {
      // Electron core
      'electron': electronShim,
      '@electron/remote': path.resolve(shimDir, 'electron-remote-shim.js'),
      '@electron/remote/main': path.resolve(shimDir, 'electron-remote-shim.js'),

      // Electron ecosystem
      'electron-redux': path.resolve(shimDir, 'electron-redux-shim.js'),
      'electron-redux/preload': path.resolve(shimDir, 'electron-redux-shim.js'),
      'electron-redux/main': path.resolve(shimDir, 'electron-redux-shim.js'),
      'electron-redux/renderer': path.resolve(shimDir, 'electron-redux-shim.js'),
      'electron-log': path.resolve(shimDir, 'electron-log-shim.js'),
      'electron-is-dev': path.resolve(shimDir, 'electron-is-dev-shim.js'),
      'electron-google-analytics': noopShim,
      'electron-updater': noopShim,

      // Node.js built-ins → shims
      'fs': electronShim,
      'fs-extra': electronShim,
      'child_process': noopShim,
      'os': path.resolve(shimDir, 'os-shim.js'),
      'chokidar': noopShim,
      'trash': noopShim,
      'node-machine-id': noopShim,
      'ffmpeg-static': noopShim,
      'i18next-fs-backend': noopShim,
      'tmp': noopShim,
      'execa': noopShim,
      'cross-spawn': noopShim,

      // Node network modules used by 'request' library
      'net': noopShim,
      'tls': noopShim,
      'dns': noopShim,
      'spawn-sync': noopShim
    }
  },
  // Webpack 4 automatically polyfills buffer, stream, util, events, assert, process
  // for target: 'web'. No extra config needed.
  node: {
    __dirname: true,
    __filename: true
  },
  plugins: [
    // Replace electron-redux subpath imports that aliases can't catch
    new webpack.NormalModuleReplacementPlugin(
      /electron-redux\/(preload|main|renderer)/,
      path.resolve(shimDir, 'electron-redux-shim.js')
    ),
    new webpack.ProvidePlugin({
      'THREE': 'three',
      Buffer: ['buffer', 'Buffer'],
      process: 'process'
    }),
    new webpack.DefinePlugin({
      '__WEB_MODE__': JSON.stringify(true)
    })
  ],
  externals: {
    uws: 'uws'
  }
}
