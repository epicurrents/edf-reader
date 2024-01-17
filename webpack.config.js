const path = require('path')
const webpack = require('webpack')
const TerserPlugin = require('terser-webpack-plugin')

module.exports = {
    mode: 'production',
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
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin(),
        ],
        runtimeChunk: {
            name: 'shared',
        },
    },
    output: {
        path: path.resolve(__dirname, 'umd'),
        library: "EdfFileLoader"
    },
    resolve: {
        extensions: ['.ts', '.js', '.json'],
        alias: {
            '#root': path.resolve(__dirname, './'),
            '#types': path.resolve(__dirname, 'src', 'types'),
        },
        symlinks: false
    },
}