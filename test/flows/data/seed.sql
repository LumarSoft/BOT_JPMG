-- Synthetic data for npm run test:flows (fictitious DNIs, CUIT, phones and plates).
-- run.js loads data/cleanup.sql right before this file.
INSERT INTO Client (dni, firstName, lastName, password, phone, producerId, producerCodeId, updatedAt) VALUES
 ('99000001','ANA MARIA','PRUEBA','x','341159990001',1,2,NOW(3)),
 ('99000002','LUCAS EZEQUIEL','PRUEBA','x','341159990002',1,2,NOW(3)),
 ('30712345671','TRANSPORTES PRUEBA SRL','','x',NULL,1,2,NOW(3)),
 ('99000004','MARTA','PRUEBA','x',NULL,1,2,NOW(3)),
 ('99000006','GUSTAVO','PRUEBA','x','341159990006',1,2,NOW(3)),
 ('99000008','JORGE','PRUEBA','x','341159990008',1,2,NOW(3)),
 ('99000009','CARLA','PRUEBA','x','341159990009',1,2,NOW(3));
SET @a=(SELECT id FROM Client WHERE dni='99000001'); SET @b=(SELECT id FROM Client WHERE dni='99000002');
SET @c=(SELECT id FROM Client WHERE dni='30712345671'); SET @d=(SELECT id FROM Client WHERE dni='99000004'); SET @g=(SELECT id FROM Client WHERE dni='99000006'); SET @h=(SELECT id FROM Client WHERE dni='99000009');
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900001','triunfo','auto','ENDOSOS VARIOS','2026-07-27','2027-07-27','Convenio','{"Articulo":458,"Empresa":"T","Sucursal":"CC"}',@a,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, coverage, policyId) VALUES ('ZZ901AA','CHEVROLET','ONIX 1.4','C2',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,68185,'2026-07-27','paid',@p),(2,68186,'2026-08-27','paid',@p),(3,68186,'2026-09-27','paid',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900002','triunfo','auto','REFACTURACION','2026-02-06','2027-02-06','Plan De Pago','{"Articulo":458,"Empresa":"T","Sucursal":"CC"}',@b,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('ZZ902AA','FIAT','PALIO',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,79499,'2026-08-06','paid',@p),(2,79500,'2026-09-06','paid',@p),(3,79500,'2026-10-06','paid',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900003','triunfo','moto','REFACTURACION','2026-04-10','2027-01-10','Débito Tarjeta','{"Articulo":481,"Empresa":"T","Sucursal":"CC"}',@b,1,2,NOW(3));
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
-- Carla: a home and a shop policy (no vehicle), both paid up.
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900009','triunfo','home','RENOVACION','2026-07-13','2027-07-13','Débito Caja de Ahorro','{"SDTOtrosRiesgosDatos":{"SDTRiesgosCoberturas":[{"Riesgo":"INCENDIO","Cobertura":"EDIFICIO","SumaAsegurada":"20000000.00"},{"Riesgo":"ROBO","Cobertura":"CONTENIDO GENERAL","SumaAsegurada":"2000000.00"},{"Riesgo":"CRISTALES","Cobertura":"CRISTALES","SumaAsegurada":"300000.00"}],"ObjetoSeguroDescripcion":"CALLE FALSA 123 C.P.:2000"}}',@h,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,43051,'2026-09-13','paid',@p),(2,43051,'2026-10-13','paid',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900010','triunfo','commercial','POLIZA NUEVA','2026-08-01','2027-08-01','Convenio','{}',@h,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,60000,'2026-09-01','paid',@p),(2,60000,'2026-10-01','paid',@p);
-- A chat the office answered by hand three hours ago (follow-up scenario).
INSERT INTO Conversation (waId, producerId, phoneNumberId, sessionStartedAt, lastMessageAt, updatedAt) VALUES
 ('5493419990120',1,'1109940228878973', UTC_TIMESTAMP(3) - INTERVAL 4 HOUR, UTC_TIMESTAMP(3) - INTERVAL 3 HOUR, NOW(3));
SET @cv=LAST_INSERT_ID();
INSERT INTO Message (role, content, source, createdAt, conversationId) VALUES
 ('user','Quiero hacer una denuncia, me chocaron estacionado','live', UTC_TIMESTAMP(3) - INTERVAL 4 HOUR, @cv),
 ('assistant','Hola, para la denuncia mandame fotos del daño y de tu carnet','app_echo', UTC_TIMESTAMP(3) - INTERVAL 3 HOUR, @cv);
-- Revisión 26/10 (R01–R53). Mariela: one auto with cupón, known phone, and a chat
-- the office answered three hours ago. Fabián: auto + moto, both cupón. Rocío:
-- two policies with a rejected debit each.
INSERT INTO Client (dni, firstName, lastName, password, phone, producerId, producerCodeId, updatedAt) VALUES
 ('99000010','MARIELA','PRUEBA','x','341159990010',1,2,NOW(3)),
 ('99000011','FABIAN','PRUEBA','x','341159990011',1,2,NOW(3)),
 ('99000012','ROCIO','PRUEBA','x',NULL,1,2,NOW(3));
SET @m=(SELECT id FROM Client WHERE dni='99000010'); SET @f=(SELECT id FROM Client WHERE dni='99000011'); SET @r=(SELECT id FROM Client WHERE dni='99000012');
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900020','triunfo','auto','RENOVACION','2026-08-15','2027-08-15','Plan De Pago','{"Articulo":458,"Empresa":"T","Sucursal":"CC"}',@m,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('ZZ910AA','PEUGEOT','208',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,70000,'2026-09-15','paid',@p),(2,70000,'2026-10-15','paid',@p),(3,70000,'2026-11-15','pending',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900021','triunfo','auto','RENOVACION','2026-08-20','2027-08-20','Plan De Pago','{"Articulo":458,"Empresa":"T","Sucursal":"CC"}',@f,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('ZZ911AA','RENAULT','KANGOO',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,65000,'2026-09-20','paid',@p),(2,65000,'2026-10-20','paid',@p),(3,65000,'2026-11-20','pending',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900022','triunfo','moto','POLIZA NUEVA','2026-09-05','2027-09-05','Plan De Pago','{"Articulo":481,"Empresa":"T","Sucursal":"CC"}',@f,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('Z912AAA','YAMAHA','XTZ 125',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,18000,'2026-10-05','paid',@p),(2,18000,'2026-11-05','pending',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900023','triunfo','auto','REFACTURACION','2026-06-02','2027-06-02','Débito Tarjeta','{}',@r,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('ZZ913AA','FIAT','CRONOS',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (4,61000,'2026-09-02','paid',@p),(5,61000,'2026-10-02','rejected',@p);
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900024','triunfo','moto','REFACTURACION','2026-06-12','2027-06-12','Débito Tarjeta','{}',@r,1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('Z914AAA','MOTOMEL','SKUA 150',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (4,19000,'2026-09-12','paid',@p),(5,19000,'2026-10-12','rejected',@p);
-- Silvia (one auto with cupón) and Hernán (no policies): known phones nobody
-- else in the run uses, for the "¿Hablo con…?" cases R25 and R03.
INSERT INTO Client (dni, firstName, lastName, password, phone, producerId, producerCodeId, updatedAt) VALUES
 ('99000013','SILVIA','PRUEBA','x','341159990013',1,2,NOW(3)),
 ('99000014','HERNAN','PRUEBA','x','341159990014',1,2,NOW(3));
INSERT INTO Policy (certificateNumber, company, riskType, lastMovement, validFrom, validTo, paymentMethod, rawData, clientId, producerId, producerCodeId, updatedAt) VALUES
 ('9900025','triunfo','auto','RENOVACION','2026-08-10','2027-08-10','Plan De Pago','{"Articulo":458,"Empresa":"T","Sucursal":"CC"}',(SELECT id FROM Client WHERE dni='99000013'),1,2,NOW(3));
SET @p=LAST_INSERT_ID(); INSERT INTO Vehicle (licensePlate, brand, model, policyId) VALUES ('ZZ915AA','TOYOTA','ETIOS',@p);
INSERT INTO Installment (number, amount, dueDate, status, policyId) VALUES (1,72000,'2026-09-10','paid',@p),(2,72000,'2026-10-10','paid',@p),(3,72000,'2026-11-10','pending',@p);
-- Chats the office handled: Mariela 3 h ago, 20 h ago (cupón y alias), 24 h ago
-- ("Gracias lu"), 60 h ago, and one with the bot paused.
INSERT INTO Conversation (waId, producerId, phoneNumberId, sessionStartedAt, lastMessageAt, updatedAt) VALUES
 ('5493419990010',1,'1109940228878973', UTC_TIMESTAMP(3) - INTERVAL 4 HOUR, UTC_TIMESTAMP(3) - INTERVAL 3 HOUR, NOW(3));
SET @cv=LAST_INSERT_ID();
INSERT INTO Message (role, content, source, createdAt, conversationId) VALUES
 ('user','Hola, quería pagar la cuota del auto','live', UTC_TIMESTAMP(3) - INTERVAL 4 HOUR, @cv),
 ('assistant','¿Pudiste hacer la transferencia?','app_echo', UTC_TIMESTAMP(3) - INTERVAL 3 HOUR, @cv);
-- The office took it over a minute ago (an older takeover is released by the API's sweep).
INSERT INTO Conversation (waId, producerId, phoneNumberId, sessionStartedAt, lastMessageAt, botPaused, handedOverAt, status, updatedAt) VALUES
 ('5493419990121',1,'1109940228878973', UTC_TIMESTAMP(3) - INTERVAL 5 MINUTE, UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE, 1, UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE, 'pending', NOW(3));
SET @cv=LAST_INSERT_ID();
INSERT INTO Message (role, content, source, createdAt, conversationId) VALUES
 ('user','Mili, te consulto algo','live', UTC_TIMESTAMP(3) - INTERVAL 5 MINUTE, @cv),
 ('agent','Decime','live', UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE, @cv);
INSERT INTO Conversation (waId, producerId, phoneNumberId, sessionStartedAt, lastMessageAt, updatedAt) VALUES
 ('5493419990122',1,'1109940228878973', UTC_TIMESTAMP(3) - INTERVAL 21 HOUR, UTC_TIMESTAMP(3) - INTERVAL 20 HOUR, NOW(3));
SET @cv=LAST_INSERT_ID();
INSERT INTO Message (role, content, source, createdAt, conversationId) VALUES
 ('user','Me pasás el cupón de octubre?','live', UTC_TIMESTAMP(3) - INTERVAL 21 HOUR, @cv),
 ('assistant','Te paso el cupón. Si preferís transferir, el alias es TRUENO.VUELO.DELTA','app_echo', UTC_TIMESTAMP(3) - INTERVAL 20 HOUR, @cv);
INSERT INTO Conversation (waId, producerId, phoneNumberId, sessionStartedAt, lastMessageAt, updatedAt) VALUES
 ('5493419990123',1,'1109940228878973', UTC_TIMESTAMP(3) - INTERVAL 61 HOUR, UTC_TIMESTAMP(3) - INTERVAL 60 HOUR, NOW(3));
SET @cv=LAST_INSERT_ID();
INSERT INTO Message (role, content, source, createdAt, conversationId) VALUES
 ('user','Hola, consulta por la póliza','live', UTC_TIMESTAMP(3) - INTERVAL 61 HOUR, @cv),
 ('assistant','Hola, ya te la mandé por mail','app_echo', UTC_TIMESTAMP(3) - INTERVAL 60 HOUR, @cv);
INSERT INTO Conversation (waId, producerId, phoneNumberId, sessionStartedAt, lastMessageAt, updatedAt) VALUES
 ('5493419990124',1,'1109940228878973', UTC_TIMESTAMP(3) - INTERVAL 25 HOUR, UTC_TIMESTAMP(3) - INTERVAL 24 HOUR, NOW(3));
SET @cv=LAST_INSERT_ID();
INSERT INTO Message (role, content, source, createdAt, conversationId) VALUES
 ('user','Ya está aplicado el pago?','live', UTC_TIMESTAMP(3) - INTERVAL 25 HOUR, @cv),
 ('assistant','Gracias lu','app_echo', UTC_TIMESTAMP(3) - INTERVAL 24 HOUR, @cv);
