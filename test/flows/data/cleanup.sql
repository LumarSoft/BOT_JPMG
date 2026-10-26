-- Removes everything the flow suite creates (synthetic clients, their chats,
-- claims, leads and notices). Safe to run any number of times.
DELETE n FROM Notification n JOIN ContactLead l ON l.id=n.refId JOIN Conversation c ON c.id=l.conversationId WHERE c.waId LIKE '5493419990%' AND n.type IN ('lead','solicitud');
DELETE l FROM ContactLead l JOIN Conversation c ON c.id=l.conversationId WHERE c.waId LIKE '5493419990%';
DELETE n FROM Notification n JOIN Claim cl ON cl.id=n.refId JOIN Client c ON c.id=cl.clientId WHERE c.dni IN ('99000001','99000002','30712345671','99000004','99000006','99000008','99000009','99000010','99000011','99000012','99000013','99000014') AND n.type='siniestro';
DELETE cl FROM Claim cl JOIN Client c ON c.id=cl.clientId WHERE c.dni IN ('99000001','99000002','30712345671','99000004','99000006','99000008','99000009','99000010','99000011','99000012','99000013','99000014');
DELETE n FROM Notification n JOIN Conversation c ON c.id=n.refId WHERE c.waId LIKE '5493419990%' AND n.type IN ('handoff','baja_poliza');
DELETE m FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.waId LIKE '5493419990%';
DELETE FROM Conversation WHERE waId LIKE '5493419990%';
DELETE i FROM Installment i JOIN Policy p ON p.id=i.policyId JOIN Client c ON c.id=p.clientId WHERE c.dni IN ('99000001','99000002','30712345671','99000004','99000006','99000008','99000009','99000010','99000011','99000012','99000013','99000014');
DELETE v FROM Vehicle v JOIN Policy p ON p.id=v.policyId JOIN Client c ON c.id=p.clientId WHERE c.dni IN ('99000001','99000002','30712345671','99000004','99000006','99000008','99000009','99000010','99000011','99000012','99000013','99000014');
DELETE p FROM Policy p JOIN Client c ON c.id=p.clientId WHERE c.dni IN ('99000001','99000002','30712345671','99000004','99000006','99000008','99000009','99000010','99000011','99000012','99000013','99000014');
DELETE FROM Client WHERE dni IN ('99000001','99000002','30712345671','99000004','99000006','99000008','99000009','99000010','99000011','99000012','99000013','99000014');
