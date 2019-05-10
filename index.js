'use strict';
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

const app = dialogflow({ clientId: CLIENT_ID });

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
expressApp.listen(process.env.PORT || 8080, () => console.log(`Server started`));

/**
 * Default Welcome Intent
 */
app.intent('Default Welcome Intent', conv => {
  // Create a session for this user at the beginning so user
  // is logged on to Circuit by the time needed
  if (!sessions[conv.user.storage]) {
    createSession(conv.user);
  }

  conv.ask(`What can I do for you?`);
  conv.ask(new Suggestions('Send a message', 'Make a call'));
});

/**
 * add.participant.to.group
 */
app.intent('add.participant.to.group', async (conv, { convName, user }) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const users = await searchUsers(circuit, conv, user);
  let convs = await circuit.searchConversationsByName(convName);

  // Save results to context
  conv.contexts.set('addparticipantgroup_data', 5, {
    users: users,
    convs: convs
  });

  if (users.length !== 1) {
    conv.contexts.set('addparticipantgroup_getuser', 5);
    return;
  }

  // No conversation found
  if (!convs.length) {
    conv.ask(`I cannot find any conversation called ${convName}. What's the name?`);
    conv.contexts.set('addparticipantgroup_getconv', 5);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found.
    convs = convs.slice(0, Math.min(7, convs.length));
    const suggestions = convs.map(c => c.topic);
    conv.ask(`More than one conversation was found with the name ${convName}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('addparticipantgroup_getconv', 5);
    return;
  }

  // One result found for user and conversation
  conv.ask(`Ready to add ${users[0].displayName} to ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.group - collect.conv
 */
app.intent('add.participant.to.group - collect.conv', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { users } = conv.contexts.input['addparticipantgroup_data'].parameters;
  const convName = conv.parameters.convName;
  let convs = await circuit.searchConversationsByName(convName);

  // No conversation found
  if (!convs.length) {
    conv.ask(`I cannot find any conversation called ${convName}. What's the name?`);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found
    let shortestConv = convs[0];

    // Loop through convs to find shortest conv name
    convs.forEach(conv => {
      if (conv.topic < shortestConv.topic) {
        shortestConv = conv;
      }
    });
    convs = [shortestConv];
  }
  // Save conversation to context because only one found
  conv.contexts.set('addparticipantgroup_data', 5, { convs: convs });
  conv.contexts.delete('addparticipantgroup_getconv');

  // Users.length is always equal to one at this point
  conv.ask(`Ready to add ${users[0].displayName} to ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.group - collect.user
 */
app.intent('add.participant.to.group - collect.user', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let { convs } = conv.contexts.input['addparticipantgroup_data'].parameters;
  const user = conv.parameters.user;
  const users = await searchUsers(circuit, conv, user);

  // Stays in this intent and gets input from user again
  if (users.length !== 1) {
    return;
  }

  // Save user to context because only one found
  conv.contexts.set('addparticipantgroup_data', 5, { users: users });
  conv.contexts.delete('addparticipantgroup_getuser');

  // No conversation found
  if (!convs.length) {
    conv.ask(`Thank you. I did not find the conversation name that you gave me earlier. What is it again?`);
    conv.contexts.set('addparticipantgroup_getconv', 5);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found.
    convs = convs.slice(0, Math.min(7, convs.length));
    const suggestions = convs.map(c => c.topic);
    conv.ask(`Thank you. I found more than one result for the conversation name you gave me earlier. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('addparticipantgroup_getconv', 5);
    return;
  }
  // One result found for user and conversation
  conv.ask(`Ready to add ${user} to ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.group - no
 */
app.intent('add.participant.to.group - no', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  conv.ask('Is there anything else I can do for you?', new Suggestions('Yes', 'No'));
  conv.contexts.delete('addparticipantgroup_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * add.participant.to.group - yes
 */
app.intent('add.participant.to.group - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { users, convs } = conv.contexts.input['addparticipantgroup_data'].parameters;
  const thisUser = circuit.user;

  // User is already in the conversation
  if (convs[0].participants.some(userId => userId === users[0].userId)) {
    conv.ask(`${users[0].displayName} is already a participant in ${convs[0].topic}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('addparticipantgroup_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  // Conversation is moderated and user is not a moderator
  if (convs[0].isModerated && !convs[0].moderators.some(userId => userId === thisUser.userId)) {
    conv.ask(`Sorry, but you are not a moderator in ${convs[0].topic} so ${users[0].displayName} cannot be added. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('addparticipantgroup_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  await circuit.addParticipant(convs[0].convId, users[0].userId, true);
  conv.ask(`${users[0].displayName} was added to ${convs[0].topic}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
  conv.contexts.delete('addparticipantgroup_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * add.participant.to.one
 */
app.intent('add.participant.to.one', async (conv, { thirdUser, target }) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const thirdUsers = await searchUsers(circuit, conv, thirdUser);
  const params = {
    thirdUsers: thirdUsers,
    targetQuery: conv.parameters.target
  }

  // Save results to context
  conv.contexts.set('addparticipantone_data', 5, params);

  if (thirdUsers.length !== 1) {
    conv.contexts.set('addparticipantone_getuser', 5);
    return;
  }

  const targetUsers = await searchUsers(circuit, conv, target);
  params.targetUsers = targetUsers;

  // Save results to context
  conv.contexts.set('addparticipantone_data', 5, params);

  if (targetUsers.length !== 1) {
    conv.contexts.set('addparticipantone_getuser', 5);
    return;
  }

  // One result found for thirdUser and target
  conv.ask(`Ready to add ${thirdUsers[0].displayName} to your conversation with ${targetUsers[0].displayName}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.one - collect.user
 */
app.intent('add.participant.to.one - collect.user', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { thirdUsers, targetQuery } = conv.contexts.input['addparticipantone_data'].parameters;
  let { targetUsers } = conv.contexts.input['addparticipantone_data'].parameters;
  const user = conv.parameters.user;
  const users = await searchUsers(circuit, conv, user);

  // Stays in this intent and gets input from user again
  if (users.length !== 1) {
    return;
  }

  // One user found beyond this point
  const params = conv.contexts.input['addparticipantone_data'].parameters;

  // Add thirdUser to context
  if (thirdUsers.length !== 1) {
    params.thirdUsers = [users[0]];
    conv.contexts.set('addparticipantone_data', 5, params);
    conv.ask('Thank you.');
  }

  // Searches for target user
  if (!targetUsers) {
    targetUsers = await searchUsers(circuit, conv, targetQuery);

    // Add the target user to context
    if (targetUsers.length !== 1) {
      params.targetUsers = targetUsers;
      conv.contexts.set('addparticipantone_data', 5, params);

      // Stays in this intent and gets input from user again
      return;
    }
  }

  // Add the target user to context
  if (targetUsers.length !== 1) {
    params.targetUsers = [users[0]];
    conv.contexts.set('addparticipantone_data', 5, params);
  }

  conv.ask(`Ready to add ${thirdUsers[0].displayName} to your conversation with ${users[0].displayName}?`, new Suggestions('Yes', 'No'));
});

/**
 * add.participant.to.one - no
 */
app.intent('add.participant.to.one - no', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  conv.ask('Is there anything else I can do for you?', new Suggestions('Yes', 'No'));
  conv.contexts.delete('addparticipantone_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * add.participant.to.one - yes
 */
app.intent('add.participant.to.one - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { thirdUsers, targetUsers } = conv.contexts.input['addparticipantone_data'].parameters;
  const conversation = await circuit.getDirectConversationWithUser(targetUsers[0].userId);

  // No direct conversation found
  if (!conversation) {
    conv.ask(`You are not in a direct conversation with ${targetUsers[0].displayName}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('addparticipantone_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  // thirdUser and targetUser are the same user
  if (thirdUsers[0].userId === targetUsers[0].userId) {
    conv.ask(`I cannot add ${thirdUsers[0].displayName} to his own conversation. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('addparticipantone_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  await circuit.addParticipant(conversation.convId, thirdUsers[0].userId);

  conv.ask(`${thirdUsers[0].displayName} has been added to your conversation with ${targetUsers[0].displayName}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
  conv.contexts.delete('addparticipantone_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * remove.participant
 */
app.intent('remove.participant', async (conv, { user, convName }) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const users = await searchUsers(circuit, conv, user);
  let convs = await circuit.searchConversationsByName(convName);

  // Save results to context
  conv.contexts.set('removeparticipant_data', 5, {
    users: users,
    convs: convs
  });

  if (users.length !== 1) {
    conv.contexts.set('removeparticipant_getuser', 5);
    return;
  }

  // No conversation found
  if (!convs.length) {
    conv.ask(`I cannot find any conversation called ${convName}. What's the name?`);
    conv.contexts.set('removeparticipant_getconv', 5);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found.
    convs = convs.slice(0, Math.min(7, convs.length));
    const suggestions = convs.map(c => c.topic);
    conv.ask(`More than one conversation was found with the name ${convName}. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('removeparticipant_getconv', 5);
    return;
  }

  // One result found for user and conversation
  conv.ask(`Ready to remove ${users[0].displayName} from ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * remove.participant - collect.conv
 */
app.intent('remove.participant - collect.conv', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { users } = conv.contexts.input['removeparticipant_data'].parameters;
  const convName = conv.parameters.convName;
  let convs = await circuit.searchConversationsByName(convName);

  // No conversation found
  if (!convs.length) {
    conv.ask(`I cannot find any conversation called ${convName}. What's the name?`);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found
    let shortestConv = convs[0];

    // Loop through convs to find shortest conv name
    convs.forEach(conv => {
      if (conv.topic < shortestConv.topic) {
        shortestConv = conv;
      }
    });
    convs = [shortestConv];
  }
  // Save conversation to context because only one found
  conv.contexts.set('removeparticipant_data', 5, { convs: convs });
  conv.contexts.delete('removeparticipant_getconv');

  // Users.length is always equal to one at this point
  conv.ask(`Ready to remove ${users[0].displayName} from ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * remove.participant - collect.user
 */
app.intent('remove.participant - collect.user', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let { convs } = conv.contexts.input['removeparticipant_data'].parameters;
  const user = conv.parameters.user;
  const users = await searchUsers(circuit, conv, user);

  // Stays in this intent and gets input from user again
  if (users.length !== 1) {
    return;
  }

  // Save user to context because only one found
  conv.contexts.set('removeparticipant_data', 5, { users: users });
  conv.contexts.delete('removeparticipant_getuser');

  // No conversation found
  if (!convs.length) {
    conv.ask(`Thank you. I did not find the conversation name that you gave me earlier. What is it again?`);
    conv.contexts.set('removeparticipant_getconv', 5);
    return;
  } else if (convs.length > 1) {
    // Multiple conversations found.
    convs = convs.slice(0, Math.min(7, convs.length));
    const suggestions = convs.map(c => c.topic);
    conv.ask(`Thank you. I found more than one result for the conversation name you gave me earlier. What's the full name?`, new Suggestions(suggestions));
    conv.contexts.set('removeparticipant_getconv', 5);
    return;
  }

  // One result found for user and conversation
  conv.ask(`Ready to remove ${user} from ${convs[0].topic}?`, new Suggestions('Yes', 'No'));
});

/**
 * remove.participant - no
 */
app.intent('remove.participant - no', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  conv.ask('Is there anything else I can do for you?', new Suggestions('Yes', 'No'));
  conv.contexts.delete('removeparticipant_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * remove.participant - yes
 */
app.intent('remove.participant - yes', async conv => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  const { users, convs } = conv.contexts.input['removeparticipant_data'].parameters;
  const thisUser = circuit.user;

  // User is not in the conversation
  if (!convs[0].participants.some(userId => userId === users[0].userId)) {
    conv.ask(`${users[0].displayName} is not a participant in ${convs[0].topic}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('removeparticipant_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  // Conversation is moderated and thisUser is not a moderator
  if (convs[0].isModerated && !convs[0].moderators.some(userId => userId === thisUser.userId)) {
    conv.ask(`Sorry, but you are not a moderator in ${convs[0].topic} so ${users[0].displayName} cannot be removed. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
    conv.contexts.delete('removeparticipant_data');
    conv.contexts.set('anything_else', 2);
    return;
  }

  await circuit.removeParticipant(convs[0].convId, users[0].userId);
  conv.ask(`${users[0].displayName} was removed from ${convs[0].topic}. Is there anything else I can do for you?`, new Suggestions('Yes', 'No'));
  conv.contexts.delete('removeparticipant_data');
  conv.contexts.set('anything_else', 2);
});

/**
 * send.message
 */
app.intent('send.message', async (conv, { target, message }) => {
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
    conv.contexts.set('sendmessage_getconv', 5);
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

  const suggestions = users.map(u => u.displayName);
  conv.contexts.set('sendmessage_getconv', 5);

  conv.ask(`More than one user found with name ${target}. What's the full name?`, new Suggestions(suggestions));
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

  const { convId } = users.length && (await circuit.getDirectConversationWithUser(users[0].userId, true));
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
app.intent('call.user', async (conv, { target }) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let users = await searchUsers(circuit, conv, target);

  if (users.length !== 1) {
    conv.contexts.set('calluser_getuser', 5);
    return;
  }

  // One result found. Ask user for confirmation.
  const name = users.length && users[0].displayName;
  conv.ask(`<speak>Ready to call ${name}?</speak>`, new Suggestions('Yes', `No`));
  conv.contexts.set('calluser_data', 5, {
    email: users[0].emailAddress,
    name: name
  });
});

/**
 * call.user - collect target
 */
app.intent('call.user - collect target', async (conv, { target }) => {
  const circuit = await getCircuit(conv);
  if (!circuit) {
    return;
  }

  let users = await searchUsers(circuit, conv, target);

  // Stays in this intent and gets input from user again
  if (users.length !== 1) {
    return;
  }

  // One result found. Ask user for confirmation.
  const name = users.length && users[0].displayName;
  conv.ask(`<speak>Ready to call ${name}?</speak>`, new Suggestions('Yes', `No`));
  conv.contexts.set('calluser_data', 5, {
    email: users[0].emailAddress,
    name: name
  });
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
    const session = sessions[conv.user.storage] || (await createSession(conv.user));
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
      if (untilTime || duration) {
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
 * Collects the presenceType of an online user and sets the presence
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

  if (userPresence === Circuit.Enums.PresenceState.DND) {
    const timeLeft = await circuit.getDndTime();
    const mLeft = Math.floor((timeLeft - Date.now()) / 60000);//sets the time left in minutes

    if (mLeft > 60) {
      conv.ask(`You are set to "Do Not Disturb" for another ${Math.floor(mLeft / 60)} hour(s) and ${Math.floor(((mLeft / 60)- Math.floor(mLeft / 60)) * 60)} minute(s). Anything Else?`);
      conv.contexts.set('anything_else', 5);
    } else  {
      conv.ask(`You are set to "Do Not Disturb" for another ${mLeft} minute(s). Would there be anything else?`);
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
  const { statusMessage } = conv.contexts.input['setstatusmessage_data'].parameters;

  await circuit.client.setStatusMessage(statusMessage)
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

  const statusMessage = await circuit.client.getStatusMessage();
  if (statusMessage) {
    conv.ask(`Your status message is '${statusMessage}'. May I do anything else for you today?`);
    conv.contexts.set('anything_else', 5);
  } else {
      conv.ask(`It appears your status message is blank. May I do anything else for you today?`);
      conv.contexts.set('anything_else', 5);
      conv.ask(new Suggestions('Set status Message', 'Yes, please', 'No, thank you'));
  }

});

/**
 * Create Circuit session
 */
function createSession(user) {
  const circuit = new CircuitClient({ client_id: CLIENT_ID });
  return circuit.logon(user.access.token)
    .then(() => {
      const session = {
        circuit: circuit,
        timer: setTimeout(clearSession.bind(null, user.storage), SESSION_TIMEOUT)
      }
      sessions[user.storage] = session;
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
      return device.clientId !== circuit.user.clientId && (device.clientInfo.deviceType === 'WEB' || (device.clientInfo.deviceType === 'APPLICATION' && device.clientInfo.deviceSubtype === 'DESKTOP_APP'));
    });
  });
}

/**
 * Search for a user
 */
async function searchUsers(circuit, conv, query) {
  let users = await circuit.searchUsers(query);

  if (!users.length) {
    // No user found
    conv.ask(`I cannot find any user called ${query}. What's the name?`);
  } else if (users.length > 1) {
    // Multiple users found
    users = users.slice(0, Math.min(7, users.length));
    const suggestions = users.map(u => u.displayName);

    conv.ask(`More than one user was found with the name ${query}. What's the full name?`, new Suggestions(suggestions));
  }

  return users;
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
function destroy() {
  let promises = [];
  Object.keys(sessions).forEach(key => promises.push(clearSession(key)));
  sessions = [];
  return Promise.all(promises);
}
