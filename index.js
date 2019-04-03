'use strict'
const { dialogflow, Suggestions } = require('actions-on-google');
const express = require('express');
const bodyParser = require('body-parser');
const CircuitClient = require('./circuitClient');

// Client ID for IMPLICIT app on Circuit. Same ID needs to be defined
// in Account Linking of your project at console.actions.google.com
const CLIENT_ID = 'd34edad8cda6433bb062f0671f58c232';

// Circuit session timeout
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5min session timeout

const sessions = {}; // Active sessions

const app = dialogflow({clientId: CLIENT_ID});

// Create express app to for handling the /_ah/start request posted
// by AppEngine
const expressApp = express();
expressApp.get('/_ah/start', (req, res) => {
  console.log('handle _ah/start');
  res.sendStatus(200);
});

// Add dialogFlow as middleware
expressApp.use(bodyParser.json(), app);

// Start server
expressApp.listen(process.env.PORT || 8080);


/**
 * Default Welcome Intent
 */
app.intent('Default Welcome Intent', conv => {
  // Create a session for this user at the beginning so user
  // is logged on to Circuit by the time needed
  if (!sessions[conv.user.id]) {
    createSession(conv.user);
  }

  conv.ask(`What can I do for you?`);
  conv.ask(new Suggestions('Send a message', 'Make a call'));
});

/**
 * message.send
 */
app.intent('send.message', async (conv, {target, message}) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  target = target || conv.contexts.input['sendmessage_data'].parameters.target;
  message = message || conv.contexts.input['sendmessage_data'].parameters.message;

  let users = await circuit.searchUsers(target);
  let convs = await circuit.searchConversationsByName(target);

  if (!users.length && !convs.length) {
    conv.ask(`I cannot find any user or conversation called ${target}. What's the name?`);
    return;
  }

  if (users.length + convs.length === 1) {
    // One result found. Ask user for confirmation.
    const { convId } = users.length && await circuit.getDirectConversationWithUser(users[0].userId, true);
    const name = users.length && users[0].displayName || convs[0].topic;
    conv.ask(`<speak>Ready to send <break time='0.5s'/>${message}<break time='0.5s'/> to ${name}?</speak>`, new Suggestions('Yes', `No, don't send it`));
    conv.contexts.set('sendmessage_send', 5, {
      convId: convId || convs[0].convId
    });
    return;
  }

  // Multiple matches. Show suggestions of the first few matches.
  users = users.slice(0, Math.min(7, users.length));
  //convs = convs.slice(0, Math.min(7, convs.length));

  const suggestions = users.map(u => u.displayName);
  conv.contexts.set('sendmessage_getconv', 5);

  conv.ask(`More than one user found with name ${target}. What's the full name?`, new Suggestions(suggestions));
  conv.ask(new Suggestions(suggestions));
});

/**
 * send.message - collect.target
 */
app.intent('send.message - collect.target', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let users = await circuit.searchUsers(conv.parameters.target);
  let convs = await circuit.searchConversationsByName(conv.parameters.target);
  if (!users.length && !convs.length) {
    conv.ask(`I cannot find any user or conversation called ${target}. What's the name?`);
    return;
  }

  const { convId } = users.length && await circuit.getDirectConversationWithUser(users[0].userId, true);
  const { message } = conv.contexts.input['sendmessage_data'].parameters;
  const name = users.length && users[0].displayName || convs[0].topic;
  conv.ask(`<speak>Ready to send <break time='0.5s'/>${message}<break time='0.5s'/> to ${name}?</speak>`, new Suggestions('Yes', `No, don't send it`));
  conv.contexts.set('sendmessage_send', 5, {
    convId: convId || convs[0].convId
  });
});

/**
 * send.message - yes
 */
app.intent('send.message - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }
  const { message } = conv.contexts.input['sendmessage_data'].parameters;
  const { convId } = conv.contexts.input['sendmessage_send'].parameters;
  await circuit.addTextItem(convId, message);
  conv.contexts.delete('sendmessage_data');
  conv.ask('Message sent. Is there anything else I can do for you?');
  conv.ask(new Suggestions('No, that\'s all', 'Yes'));
  conv.contexts.set('anything_else', 2);
});

/**
 * send.message - no
 */
app.intent('send.message - no', async conv => {
  conv.contexts.delete('sendmessage_data');
  conv.ask('Message not sent. Is there anything else I can do for you?');
  conv.ask(new Suggestions('No, that\'s all', 'Yes'));
  conv.contexts.set('anything_else', 2);
});

/**
* call.user
*/
app.intent('call.user', async (conv, {target}) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let users = await circuit.searchUsers(target);

  if (!users.length) {
    conv.contexts.set('calluser_getuser', 5);
    conv.ask(`I cannot find any user called ${target}. What's the name?`);
    return;
  }

  if (users.length === 1) {
    // One result found. Ask user for confirmation.
    const name = users.length && users[0].displayName;
    conv.ask(`<speak>Ready to call ${name}?</speak>`, new Suggestions('Yes', `No`));
    conv.contexts.set('calluser_data', 5, {
      email: users[0].emailAddress,
      name: name
    });
    return;
  }

  // Multiple matches. Show suggestions of the first few matches.
  users = users.slice(0, Math.min(7, users.length));

  const suggestions = users.map(u => u.displayName);
  conv.contexts.set('calluser_getuser', 5);

  conv.ask(`More than one user found with name ${target}. What's the full name?`, new Suggestions(suggestions));
  conv.ask(new Suggestions(suggestions));
});

/**
 * call.user - collect target
 */
app.intent('call.user - collect target', async (conv, {target}) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let users = await circuit.searchUsers(target);

  if (!users.length) {
    conv.ask(`I cannot find any user called ${target}.`);
    return;
  }

  if (users.length === 1) {
    // One result found. Ask user for confirmation.
    const name = users.length && users[0].displayName;
    conv.ask(`<speak>Ready to call ${name}?</speak>`, new Suggestions('Yes', `No`));
    conv.contexts.set('calluser_data', 5, {
      email: users[0].emailAddress,
      name: name
    });
    return;
  }

  // Multiple matches. Show suggestions of the first few matches.
  users = users.slice(0, Math.min(7, users.length));

  const suggestions = users.map(u => u.displayName);
  conv.contexts.set('calluser_getuser', 5);

  conv.ask(`More than one user or conversation found with name ${target}. What's the full name?`, new Suggestions(suggestions));
  conv.ask(new Suggestions(suggestions));
});

/**
 * call.user - yes
 */
app.intent('call.user - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }
  const device = await findWebClient(circuit);
  const { email, name } = conv.contexts.input['calluser_data'].parameters;
  try {
    await circuit.sendClickToCallRequest(email, null, device && device.clientId, true);
    conv.ask(`Ok, calling ${name} on your browser.`);
  } catch (err) {
    conv.ask(`Looks like you are not logged in to Circuit on your browser on the desktop. Login and try again.`);
  }
  conv.contexts.delete('calluser_data');
  conv.close();
});

app.intent('call.user - no', async conv => {
  conv.contexts.delete('calluser_data');
  conv.ask('Is there anything else I can do for you?');
  conv.ask(new Suggestions('No, that\'s all', 'Yes'));
  conv.contexts.set('anything_else', 2);
});


/**
 * Common intents
 */

app.intent('anything.else - yes', async conv => {
  conv.followup('Welcome');
});

app.intent('anything.else - no', async conv => {
  conv.ask('Good Bye');
  conv.close();
});

/**
 * Exception handler
 */
app.catch((conv, e) => {
  console.error(e);
  conv.close('Oops. Something went wrong.');
});


/**
 * Get the circuit instance from the session. Create a new session if needed
 */
async function getCircuit(conv) {
  try {
    const session = sessions[conv.user.id] || (await createSession(conv.user));
    return session.circuit;
  } catch (err) {
    conv.ask('No circuit session found. Start over please.');
    conv.close();
  }
}

/**
 * Traverses through the presence types to set to available or dnd
 */
async function traversePresence(conv) {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { presenceType } = conv.contexts.input['setpresence_data'].parameters;
  const presence = presenceType.toLowerCase();
  const { untilTime } = conv.contexts.input['setpresence_data'].parameters;
  const { duration } = conv.contexts.input['setpresence_data'].parameters;

  if (presence === 'available') {
    await circuit.setPresenceAvailable();
    conv.ask(`Your online presence is set to ${presence}. Anything Else?`);
    conv.contexts.set('anything_else', 5);
  } else if (presence === 'dnd' || presence === 'do not disturb') { 
      if(untilTime || duration){
        await circuit.setPresenceDnd(untilTime, duration);
        conv.ask(`Your online presence is set to ${presence}. Anything Else?`);
        conv.contexts.set('anything_else', 5);
      } else {
          conv.ask(`How long would you like to be set to DND?`);
          conv.contexts.set('setdnd_time', 5);
      }
  } else {
      conv.ask(`I didn't catch the presence. What would you like to be set to?`);
      conv.contexts.set('setPresence_getPresence', 5);
  }
  
}

/**
 * Set a logged on user's presence
 */
app.intent('set.presence', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }
  await traversePresence(conv);
});

/**
 * collects the presenceType of an online user
 */
app.intent('set.presence - collect presenceType', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }
  await traversePresence(conv);
});

/**
 * Set a logged on user to dnd
*/
app.intent('set.presence - dnd', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }
  const { untilTime } = conv.contexts.input['setpresence_data'].parameters;
  const { duration } = conv.contexts.input['setpresence_data'].parameters;

  await circuit.setPresenceDnd(untilTime, duration);
  conv.ask(`Your online presence is set to Do Not Disturb. Anything else?`);
  conv.contexts.set('anything_else', 5);
});

/**
 * Retrieves the presence of an online user
*/
app.intent('get.presence', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }
  const userPresence = await circuit.getUserPresence();
  conv.ask(`Your online presence is set to ${userPresence}. Anything else?`);
  conv.contexts.set('anything_else', 5);
});

/**
 * Retrieves the remaining time left in dnd
*/
app.intent('get.dndTime', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const userPresence = await circuit.getUserPresence();
  if (userPresence === 'DND') {
    const timeLeft = await circuit.getDndTime();
    const mLeft = Math.floor((timeLeft - Date.now())/60000);//sets the time left in minutes

    if (mLeft > 60) {
      conv.ask(`Your DND is set until ${Math.floor(mLeft/60)} hour(s) and ${Math.floor(((mLeft/60)- Math.floor(mLeft/60))*60)} minute(s) from now. Anything Else?`);
      conv.contexts.set('anything_else', 5);
    } else  {
      conv.ask(`Your DND is set until ${mLeft} minute(s) from now. Would there be anything else?`);
      conv.contexts.set('anything_else', 5);
    } 
  } else  {
      conv.ask('It seems that you are not set to Do Not Disturb. Would you like to do anything else?');
      conv.contexts.set('anything_else', 5);
  }
});

/**
 * Set a logged on user's status message
*/
app.intent('set.statusmessage', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }
  const {statusMessage} = conv.contexts.input['setstatusmessage_data'].parameters;

  await circuit.setMyStatusMessage(statusMessage);
  conv.ask(`Your status message is now set to '${statusMessage}'. May I do anything else for you today?`);
  conv.contexts.set('anything_else', 5);
});

/**
 * Retrieve a logged on user's status message
*/
app.intent('get.statusmessage', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const statusMessage = await circuit.getMyStatusMessage();
  if (statusMessage !== '') {
    conv.ask(`Your status message is '${statusMessage}'. May I do anything else for you today?`);
    conv.contexts.set('anything_else', 5);
  } else if (statusMessage === '') {
      conv.ask(`It appears your status message is blank. May I do anything else for you today?`);
      conv.contexts.set('anything_else', 5);
      conv.ask(new Suggestions('Set status Message', 'Yes, please', 'No, thank you'));
  }

});

/**
 * Create Circuit session
 */
function createSession(user) {
  const circuit = new CircuitClient({client_id: CLIENT_ID});
  return circuit.logon(user.access.token)
    .then(() => {
      const session = {
        circuit: circuit,
        timer: setTimeout(clearSession.bind(null, user.id), SESSION_TIMEOUT)
      }
      sessions[user.id] = session;
      return session;
    })
    .catch(err => console.error(`Unable to logon to Circuit`, err));
}

/**
 * Find web client of logged on user
 */
function findWebClient(circuit) {
  return circuit.getDevices().then(devices => {
      return devices.find(device => {
          return (device.clientId !== circuit.user.clientId) &&
              ((device.clientInfo.deviceType === 'WEB') ||
              (device.clientInfo.deviceType === 'APPLICATION' && device.clientInfo.deviceSubtype === 'DESKTOP_APP'));
      });
  });
}

/**
 * clearSession
 */
function clearSession(sessionId) {
  let session = sessions[sessionId];
  if (!session) {
    return Promise.resolve();
  }
  console.log(`Clearing session ${sessionId}`);
  clearTimeout(session.timer);
  session.timer = null;
  sessions[sessionId] = null;
  return session.circuit.logout();
}

/**
 * destroy
 */
function destroy() {;
  let promises = [];
  Object.keys(sessions).forEach(key => promises.push(clearSession(key)));
  sessions = [];
  return Promise.all(promises);
}
