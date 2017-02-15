/*
    Copyright (c) 2016 Unify Inc.

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the "Software"),
    to deal in the Software without restriction, including without limitation
    the rights to use, copy, modify, merge, publish, distribute, sublicense,
    and/or sell copies of the Software, and to permit persons to whom the Software
    is furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
    OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
    CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
    TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
    OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

'use strict'

const bunyan = require('bunyan');
const ApiAiAssistant = require('actions-on-google').ApiAiAssistant;
const express = require('express');
const bodyParser = require('body-parser');
const basicAuth = require('express-basic-auth');
const app = express();
const log = require('./logger');
const va = require('./va');
const sessionHandler = require('./sessionHandler');
const config = require('./config.json');


// Express middleware
app.set('port', (process.env.PORT || 8080));
app.use(bodyParser.json({type: 'application/json'}));

// Basic Auth for webhook connection to API.AI
config.webhook && app.use(basicAuth(config.webhook));

// Circuit session middleware
app.use(sessionHandler());

// Setup virtual assistant routes
va.init(app);

// Graceful shutdown. Wait to allow sessionHandler middleware to clean up.
process.on('SIGINT', _ => setTimeout(_ => process.exit(), 200));

// Start the server
let server = app.listen(app.get('port'), _ => {
  console.log(`App listening on port ${server.address().port}.`);
  console.log('Press Ctrl+C to quit.');
});
