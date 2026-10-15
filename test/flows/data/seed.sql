-- Synthetic data for npm run test:flows (fictitious DNIs, CUIT, phones and plates).
-- run.js loads data/cleanup.sql right before this file.
INSERT INTO Client (dni, firstName, lastName, password, phone, producerId, producerCodeId, updatedAt) VALUES
 ('99000001','ANA MARIA','PRUEBA','x','341159990001',1,2,NOW(3)),
 ('99000002','LUCAS EZEQUIEL','PRUEBA','x','341159990002',1,2,NOW(3)),
 ('30712345671','TRANSPORTES PRUEBA SRL','','x',NULL,1,2,NOW(3)),
 ('99000004','MARTA','PRUEBA','x',NULL,1,2,NOW(3)),
 ('99000006','GUSTAVO','PRUEBA','x','341159990006',1,2,NOW(3));
SET @a=(SELECT id FROM Client WHERE dni='99000001'); SET @b=(SELECT id FROM Client WHERE dni='99000002');
SET @c=(SELECT id FROM Client WHERE dni='30712345671'); SET @d=(SELECT id FROM Client WHERE dni='99000004'); SET @g=(SELECT id FROM Client WHERE dni='99000006');
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900001','triunfo','auto','ENDOSOS VARIOS','2026-07-27','2027-07-27','Convenio','{}',@a,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('ZZ901AA','CHEVROLET','ONIX 1.4',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,68185,'2026-07-27','paid',@p),(2,68186,'2026-08-27','paid',@p),(3,68186,'2026-09-27','paid',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900002','triunfo','auto','REFACTURACION','2026-02-06','2027-02-06','Plan De Pago','{}',@b,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('ZZ902AA','FIAT','PALIO',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,79499,'2026-08-06','paid',@p),(2,79500,'2026-09-06','paid',@p),(3,79500,'2026-10-06','paid',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900003','triunfo','moto','REFACTURACION','2026-04-10','2027-01-10','Débito Tarjeta','{}',@b,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('Z902AAA','HONDA','STORM',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,21339,'2026-10-10','overdue',@p),(2,21339,'2026-11-10','pending',@p),(3,21339,'2026-12-10','pending',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900004','triunfo','auto','RENOVACION','2026-07-26','2027-07-26','Convenio','{}',@c,1,2,NOW(3)),
 ('9900005','triunfo','auto','POLIZA NUEVA','2026-08-03','2027-08-03','Convenio','{}',@c,1,2,NOW(3));
INSERT INTO Vehicle (licensePlate, brand, model, policyId) SELECT 'ZZ903AA','MER. BENZ','L-1722/32',id FROM Policy WHERE certificateNumber='9900004';
INSERT INTO Vehicle (licensePlate, brand, model, policyId) SELECT 'ZZ904AA','RANDON','SR CS MT',id FROM Policy WHERE certificateNumber='9900005';
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900006','triunfo','auto','REFACTURACION','2026-05-27','2027-05-27','Débito Tarjeta','{}',@d,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('ZZ906AA','RENAULT','SANDERO',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (4,55000,'2026-08-27','paid',@p),(5,55000,'2026-09-27','rejected',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900007','triunfo','auto','POLIZA NUEVA','2026-09-01','2027-09-01','Convenio','{}',@g,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('ZZ907AA','FORD','FOCUS',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,90000,'2026-09-01','paid',@p),(2,90000,'2026-10-01','paid',@p);
-- A chat the office answered by hand three hours ago (follow-up scenario).
INSERT INTO Conversation (waId, producerId, phoneNumberId, sessionStartedAt, lastMessageAt, updatedAt) VALUES
 ('5493419990120',1,'1109940228878973', UTC_TIMESTAMP(3) - INTERVAL 4 HOUR, UTC_TIMESTAMP(3) - INTERVAL 3 HOUR, NOW(3));
SET @cv=LAST_INSERT_ID();
INSERT INTO Message (role, content, source, createdAt, conversationId) VALUES
 ('user','Quiero hacer una denuncia, me chocaron estacionado','live', UTC_TIMESTAMP(3) - INTERVAL 4 HOUR, @cv),
 ('assistant','Hola, para la denuncia mandame fotos del daño y de tu carnet','app_echo', UTC_TIMESTAMP(3) - INTERVAL 3 HOUR, @cv);
