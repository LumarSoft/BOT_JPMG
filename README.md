<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Prueba de todos los flujos (antes de cada deploy)

`npm run test:flows` recorre de punta a punta todos los flujos de conversación del bot (identificación, menú, siniestros, pagos, cupones, documentación, baja, asesor, cotización de auto y moto, hogar, no clientes, fotos/PDF/audio/ubicación, oficina que toma la charla e inactividad), incluidos los casos sacados de chats reales que ya se arreglaron, para confirmar que nada se rompió.

Qué hace, en una sola corrida (~7 min):

1. Compila la API (`../api_john`) y el bot.
2. Carga datos ficticios en la base local: DNI 99000001/2/4/6, CUIT 30712345671, números 5493419990xxx (`test/flows/data/seed.sql`).
3. Levanta la API en el puerto 3001 (las cotizaciones van a Triunfo con `GenerarPresupuesto=false`, como máximo una cada 2 s) y el bot en el 3002, con WhatsApp interceptado: nada sale a Meta.
4. Corre `test/flows/scenarios.js` (6 escenarios a la vez) y, aparte, los de inactividad (espera unos 4 min con el timeout local en 2 min).
5. Muestra qué pasó y qué falló (con las últimas líneas de la charla) y borra todo lo que creó: datos, archivos subidos y cotizaciones de la corrida.

```bash
npm run test:flows                        # todo
npm run test:flows -- --only=P09,C01      # algunos escenarios
npm run test:flows -- --skip-inactivity   # sin la espera de inactividad (~3 min)
npm run test:flows -- --no-build          # usar el dist/ actual de los dos repos
npm run test:flows -- --keep              # dejar los datos en la base para mirarlos
npm run test:flows -- --cleanup           # borrar los datos que dejó --keep
```

Requisitos: el repo de la API en `../api_john` (o `FLOWS_API_DIR=/ruta`) con su `.env` y la base local (`john_db`) con el número de prueba `1109940228878973` del productor 1; el cliente `mysql` instalado; los puertos 3001 y 3002 libres. Las credenciales salen de los `.env` locales y no se imprimen. Usa OpenAI (bot) y el cotizador de Triunfo de verdad: cuesta unos centavos por corrida.

El resultado sale `0` si todo pasó, `1` si falló algún escenario y `2` si no pudo correr. Los pendientes conocidos (`known` en el escenario) se informan pero no hacen fallar la corrida. El detalle de cada charla queda en `test/flows/.out/results.json` y los logs de la API y el bot en `test/flows/.out/`.

Para sumar un caso: agregar un escenario a `test/flows/scenarios.js` (qué manda el cliente en cada paso y qué debe contestar el bot, con regex; y opcionalmente qué debe quedar en la base). Siempre con datos ficticios, nunca de clientes reales.

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
