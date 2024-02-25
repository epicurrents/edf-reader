const path = require('path')
const Dotenv = require('dotenv-webpack')
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin
const CircularDependencyPlugin = require('circular-dependency-plugin')

const ASSET_PATH = process.env.ASSET_PATH || '/'
const ROOT_PATH = process.env.ROOT_PATH || '/'

module.exports = {
    mode: 'development',
    entry: {
        'edf-file-loader': { import: path.join(__dirname, 'src', 'index.ts') },
    },
    module: {
        rules: [
        {
            test: /\.tsx?$/,
            use: 'ts-loader',
            exclude: /node_modules/,
        },
        ],
    },
    devServer: {
        allowedHosts: 'all',
        client: {
            webSocketURL: 'auto://0.0.0.0:0' + ROOT_PATH + '/ws',
        },
        compress: true,
        headers: {
            // Cross-origin isolation is needed for shared memory buffers.
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        historyApiFallback: true,
        port: 8081,
        static: {
            directory: path.join(__dirname, 'dev'),
            publicPath: ROOT_PATH,
        },
    },
    output: {
        path: path.resolve(__dirname, 'dev'),
        publicPath: ASSET_PATH,
        filename: '[name].js',
        chunkFilename: '[name].js?v=[contenthash]',
        library: 'EdfReader',
        libraryTarget: 'umd'
    },
    plugins: [
        new BundleAnalyzerPlugin(),
        new CircularDependencyPlugin({
            // exclude detection of files based on a RegExp
            exclude: /a\.js|node_modules/,
            // include specific files based on a RegExp
            include: /src/,
            // add errors to webpack instead of warnings
            failOnError: true,
            // allow import cycles that include an asyncronous import,
            // e.g. via import(/* webpackMode: "weak" */ './file.js')
            allowAsyncCycles: false,
            // set the current working directory for displaying module paths
            cwd: process.cwd(),
        })
    ],
    resolve: {
        extensions: ['.ts', '.js', '.json'],
        alias: {
            '#root': path.resolve(__dirname, './'),
            '#types': path.resolve(__dirname, 'src', 'types'),
        },
        symlinks: false
    },
    stats: {
        errorDetails: true
    },
}