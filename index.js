'use strict'

const express = require('express');
const bodyParser = require('body-parser');
const basicAuth = require('express-basic-auth');
const app = express();
const va = require('./va');
//const sessionHandler = require('./sessionHandler');
const config = require('./config.json');

// Express middleware
app.set('port', (process.env.PORT || 8080));
app.use(bodyParser.json({type: 'application/json'}));

// Basic Auth for webhook connection to API.AI
//config.webhook && app.use(basicAuth(config.webhook));

// Circuit session middleware
//app.use(sessionHandler());

// Setup virtual assistant
va.init(app);

// Graceful shutdown. Wait to allow sessionHandler middleware to clean up.
process.on('SIGINT', _ => setTimeout(_ => process.exit(), 200));

// Start the server
let server = app.listen(app.get('port'), _ => {
  console.log(`App listening on port ${server.address().port}.`);
  console.log('Press Ctrl+C to quit.');
});
