'use strict';

const bunyan = require('bunyan');
const config = require('./config.json');

let level = config.logging && config.logging.nodeapp || 'info';

module.exports = bunyan.createLogger({
    name: 'app',
    stream: process.stdout,
    level: level
});