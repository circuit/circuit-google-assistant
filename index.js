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
app.intent('Default Welcome Intent', async conv => {
  // Create a session for this user at the beginning so user
  // is logged on to Circuit by the time needed
  if (!sessions[conv.user.id]) {
    createSession(conv.user);
  }

  const { inConferenceCall, conferenceAvailable } = await getConferenceInfo(conv),
  suggestions = ["Send a message", "Make a call"];
  conv.ask(`What can I do for you?`);
 
  if (inConferenceCall && conferenceAvailable) {
    suggestions.push("Leave a conference");
    suggestions.push("Join a conference");
  } else if (conferenceAvailable) {
    suggestions.push("Join a conference");
  } else if (inConferenceCall) {
    suggestions.push("Leave a conference");
  } 
  conv.ask(new Suggestions(suggestions));
});

/**
 * send.message
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
    conv.ask(`<speak>Ready to send <break time="0.5s"/>${message}<break time="0.5s"/> to ${name}?</speak>`, new Suggestions('Yes', `No, don't send it`));
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
  conv.ask(`<speak>Ready to send <break time="0.5s"/>${message}<break time="0.5s"/> to ${name}?</speak>`, new Suggestions('Yes', `No, don't send it`));
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
 * join.conference
 */
app.intent('join.conference', async (conv, { target }) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const matches = [];
  const { inConferenceCall, conferenceAvailable, calls } = await getConferenceInfo(conv);

  if (inConferenceCall) {
    conv.ask('<speak>You\'re already in a conference call. Can I do anything else for you?</speak>');
    conv.ask(new Suggestions('No, that\'s all', 'Yes'));
    conv.contexts.set('anything_else', 2); 
    return;
  } 

  if (!conferenceAvailable) {
    conv.ask(`<speak>No conferences available to join. Can I do something else for you?</speak>`);
    conv.ask(new Suggestions('No, that\'s all', 'Yes'));
    conv.contexts.set('anything_else', 2);
    return;
  }

  // If target isn't undefined
  if (target) {
    calls.forEach(c => {
      if (c.title.toLowerCase() === target.toLowerCase()) {
        matches.push(c);
      }
    });

    if (!matches.length) {
      const prompt = `<speak>I cannot find any conference call with name ${target}. Here are the names of your current ongoing conferences. 
      Which would you like to join?</speak>`;
      const titles = calls.map(call => call.title.toLowerCase());
      conv.ask(prompt, new Suggestions(titles));
      conv.contexts.set('joinconference_gettarget', 5, {
        calls: calls
      });
      return;
    }

    if (matches.length === 1) {
      // One result found. Ask user for confirmation.
      const callId = matches[0].callId;
      conv.ask(`<speak>Ready to join the <break time="0.5s"/>${target}<break time="0.5s"/> conference call?</speak>`, new Suggestions('Yes', `No, don't join`));
      conv.contexts.set('joinconference_send', 5, {
        callId: callId
      });
      return;
    }

    // Multiple matches. Tell user that they can either re-enter a conference or just join the first match.
    conv.ask(`More than one conference found with the name ${target}. Joining the first ${target} conference.`);
    const callId = matches[0].callId;
    conv.ask(`<speak>Ready to join the <break time="0.5s"/>${target}<break time="0.5s"/> conference call?</speak>`, new Suggestions('Yes', `No, don't join`));
    conv.contexts.set('joinconference_send', 5, {
      callId: callId
    });
    return;
  }

  const titles = [];
  calls.forEach(call => {
    if (!call.title) {
      const placeholder = truncate(call.topicPlaceholder);
      titles.push(placeholder);
    } else {
      titles.push(call.title);
    }
  });

  conv.ask('<speak>Which conference would you like to join? Here are your ongoing conferences.</speak>', new Suggestions(titles));
  conv.contexts.set('joinconference_gettarget', 5, {
    calls: calls, 
    titles: titles
  });
  return;
}) 


/**
 * join.conference - collect.target
 */
app.intent('join.conference - collect.target', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let callId;
  const { calls, titles } = conv.contexts.input['joinconference_gettarget'].parameters;
  const { target } = conv.parameters;

  // Lowercase titles so if the name of the conference is Test and they type in test
  // it will still be found. That is the reason for the lowercasing the target and titles.
  const lcTitles = titles.map(title => title.toLowerCase());
  const index = lcTitles.indexOf(target);

  if (index > -1) {
    callId = calls[index].callId;
  } else {
    calls.forEach(call => {
      if (call.title.toLowerCase() === target.toLowerCase()) {
        callId = call.callId;
      } 
    })
  }  
  conv.ask(`<speak>Ready to join the <break time="0.5s"/>${target}<break time="0.5s"/> conference call?</speak>`, new Suggestions('Yes', `No, don't join`));
  conv.contexts.set('joinconference_send', 5, {
    callId: callId
  });
});

/**
 * join.conference - yes
 */
app.intent('join.conference - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }
  const { clientId } = await findWebClient(circuit);
  const { callId } = conv.contexts.input['joinconference_send'].parameters;
  await circuit.joinConference(callId, {audio: true, video: false}, clientId);
  conv.contexts.delete('joinconference_data');
  conv.ask('Conference joined. Is there anything else I can do for you?');
  conv.ask(new Suggestions('No, that\'s all', 'Yes'));
  conv.contexts.set('anything_else', 2);
}); 

/**
 * join.conference - no
 */
app.intent('join.conference - no', async conv => {
  conv.contexts.delete('joinconference_data');
  conv.ask('Conference not joined. Is there anything else I can do for you?');
  conv.ask(new Suggestions('No, that\'s all', 'Yes'));
  conv.contexts.set('anything_else', 2);
});

/**
 * leave.conference
 */
app.intent('leave.conference', async (conv, {target}) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { inConferenceCall, calls } = await getConferenceInfo(conv);
 
  if (!inConferenceCall) {
    conv.contexts.delete('joinconference_data');
    conv.ask("<speak>You aren't in any conference calls. Is there anything else I can do for you?</speak>");
    conv.ask(new Suggestions('No, that\'s all', 'Yes'));
    conv.contexts.set('anything_else', 2); 
    return;
  }

  const titles = [];
  calls.forEach((call) => {
    if (!call.title.length) {
      const placeholder = truncate(call.topicPlaceholder);
      titles.push(placeholder.toLowerCase());
    } else {
      titles.push(call.title.toLowerCase());
    }
  });

  // If not undefined just send them to leaveconference_send
  if (target) {
    const i = titles.indexOf(target.toLowerCase());
    if (i > -1) {
      const callId = calls[i].callId;
      conv.ask(`<speak>Ready to leave the conference ${target}?</speak>`, new Suggestions('Yes', 'No'));
      conv.contexts.set('leaveconference_send', 5, {
        callId: callId
      });
      return;
    }
    conv.ask(`<speak>You are not in a conference named ${target}.`);
  }

  conv.ask(`<speak>Here are the conferences you're in. Which would you like to leave?</speak>`, new Suggestions(titles));
  conv.contexts.set('leaveconference_gettarget', 5, {
    calls: calls,
    titles: titles
  });
  return;
}); 

/**
 * join.conference - collect.target
 */
app.intent('leave.conference - collect.target', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let callId;
  const { calls, titles } = conv.contexts.input['leaveconference_gettarget'].parameters;
  const { target } = conv.parameters;
  
  const index = titles.indexOf(target);
  if (index > -1) {
    callId = calls[index].callId;
  } else {
    calls.forEach(call => {
      if (call.title.toLowerCase() === target.toLowerCase()) {
        callId = call.callId;
      } 
    })
  }

  conv.ask(`<speak>Ready to leave the <break time="0.5s"/>${target}<break time="0.5s"/> conference call?</speak>`, new Suggestions('Yes', `No`));
  conv.contexts.set('leaveconference_send', 5, {
    callId: callId
  });
}); 

/**
 * leave.conference - yes
 */
app.intent('leave.conference - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { callId } = conv.contexts.input['leaveconference_send'].parameters;
  try {
    await circuit.leaveConference(callId);
  } catch(e) {
    conv.contexts.delete('leaveconference_data');
    conv.ask('There was an error trying to leave the conference. You might not be in the conference anymore. Is there anything else I can do for you?');
    conv.ask(new Suggestions('No, that\'s all', 'Yes'));
    conv.contexts.set('anything_else', 2);
    return;
  }
  conv.contexts.delete('leaveconference_data');
  conv.ask('Conference left. Is there anything else I can do for you?');
  conv.ask(new Suggestions('No, that\'s all', 'Yes'));
  conv.contexts.set('anything_else', 2);
}) 

/**
 * leave.conference - no
 */
app.intent('leave.conference - no', async conv => {
  conv.contexts.delete('leaveconference_data');
  conv.ask('Conference not joined. Is there anything else I can do for you?');
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

async function lookupConversations(client, calls) {
  let i = 0;
  const result = [];
  const convIds = calls.map(call => call.convId);
  const conversations = await client.getConversationsByIds(convIds);
  conversations.forEach(conversation => {
    const data = {
      title: conversation.topic,
      callId: calls[i].callId,
      topicPlaceholder: conversation.topicPlaceholder,
      participants: conversation.participants
    };
    result.push(data);
    i++;
  });
  return result;
}

/**
 * Returns all necessary conference info needed for joining and leaving a conference.
 */
async function getConferenceInfo(conv){
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const startedCalls = await circuit.getStartedCalls();
  const calls = await lookupConversations(circuit, startedCalls);
  const remCalls = await circuit.getActiveRemoteCalls();
  const conferenceAvailable = !!startedCalls.length
  const inConferenceCall = remCalls.length >= 1;

  return {
    inConferenceCall,
    conferenceAvailable,
    calls
  }
}

/**
 * Simple truncate function as suggestions in dialogflow can't be more than 25 characters
 */
function truncate(str){
  if(str.length > 25) {
    return str.substring(0,25);
  } 
  return str;
}