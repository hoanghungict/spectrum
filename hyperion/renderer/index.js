// @flow
// Server-side renderer for our React code
const debug = require('debug')('hyperion:renderer');
import React from 'react';
// $FlowIssue
import { renderToNodeStream } from 'react-dom/server';
import { ServerStyleSheet } from 'styled-components';
import { ApolloProvider, getDataFromTree } from 'react-apollo';
import { ApolloClient } from 'apollo-client';
import { SchemaLink } from 'apollo-link-schema';
import schema from 'api/schema';
import createLoaders from 'api/loaders';
import { createHttpLink } from 'apollo-link-http';
import {
  InMemoryCache,
  IntrospectionFragmentMatcher,
} from 'apollo-cache-inmemory';
import { StaticRouter } from 'react-router';
import { Provider } from 'react-redux';
import { HelmetProvider } from 'react-helmet-async';
import Loadable from 'react-loadable';
import { getBundles } from 'react-loadable/webpack';
import Raven from 'shared/raven';
import introspectionQueryResultData from 'shared/graphql/schema.json';
// $FlowIssue
import stats from '../../build/react-loadable.json';

import getSharedApolloClientOptions from 'shared/graphql/apollo-client-options';
import { getFooter, getHeader } from './html-template';

// Browser shim has to come before any client imports
import './browser-shim';
const Routes = require('../../src/routes').default;
import { initStore } from '../../src/store';

const IS_PROD = process.env.NODE_ENV === 'production';
const FORCE_DEV = process.env.FORCE_DEV;
const FIVE_MINUTES = 300;
const ONE_HOUR = 3600;

if (!IS_PROD || FORCE_DEV) debug('Querying API at localhost:3001/api');

const renderer = (req: express$Request, res: express$Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  debug(`server-side render ${req.url}`);
  debug(`querying API at https://${req.hostname}/api`);
  const schemaLink = new SchemaLink({
    schema,
    context: {
      user: req.user || null,
      loaders: createLoaders(),
      getImageSignatureExpiration: () => {
        // see api/apollo-server.js
        const date = new Date();
        date.setHours(24);
        date.setMinutes(0);
        date.setSeconds(0);
        date.setMilliseconds(0);
        return date.getTime();
      },
    },
  });

  const cache = new InMemoryCache({
    fragmentMatcher: new IntrospectionFragmentMatcher({
      introspectionQueryResultData,
    }),
    ...getSharedApolloClientOptions(),
  });

  // Get the nonce attached to every request
  // This nonce is generated by our security middleware
  const nonce =
    typeof res.locals.nonce === 'string' ? res.locals.nonce : undefined;

  if (!nonce) throw new Error('Security nonce not set.');

  // Create an Apollo Client with a local network interface
  const client = new ApolloClient({
    ssrMode: true,
    link: schemaLink,
    cache,
  });
  // Define the initial redux state
  const { t } = req.query;

  const initialReduxState = {
    dashboardFeed: {
      activeThread: t ? t : '',
      mountedWithActiveThread: t ? t : '',
      search: {
        isOpen: false,
      },
    },
  };
  // Create the Redux store
  const store = initStore(initialReduxState);
  let modules = [];
  const report = moduleName => {
    modules.push(moduleName);
  };
  let routerContext = {};
  let helmetContext = {};
  // Initialise the styled-components stylesheet and wrap the app with it
  const sheet = new ServerStyleSheet();
  const frontend = sheet.collectStyles(
    <Loadable.Capture report={report}>
      <ApolloProvider client={client}>
        <HelmetProvider context={helmetContext}>
          <Provider store={store}>
            <StaticRouter location={req.url} context={routerContext}>
              {/* $FlowIssue */}
              <Routes />
            </StaticRouter>
          </Provider>
        </HelmetProvider>
      </ApolloProvider>
    </Loadable.Capture>
  );

  debug('get data from tree');
  getDataFromTree(frontend)
    .then(() => {
      debug('got data from tree');
      if (routerContext.url) {
        debug('found redirect on frontend, redirecting');
        // Somewhere a `<Redirect>` was rendered, so let's redirect server-side
        res.redirect(301, routerContext.url);
        return;
      }

      res.status(200);

      const state = store.getState();
      const data = client.extract();
      const { helmet } = helmetContext;
      debug('write header');
      // Use now's CDN to cache the rendered pages in CloudFlare for half an hour
      // Ref https://zeit.co/docs/features/cdn
      if (!req.user) {
        res.setHeader(
          'Cache-Control',
          `max-age=${FIVE_MINUTES}, s-maxage=${ONE_HOUR}, stale-while-revalidate=${FIVE_MINUTES}, must-revalidate`
        );
      } else {
        res.setHeader('Cache-Control', 's-maxage=0');
      }

      res.write(
        getHeader({
          metaTags:
            helmet.title.toString() +
            helmet.meta.toString() +
            helmet.link.toString(),
          nonce: nonce,
        })
      );

      const stream = sheet.interleaveWithNodeStream(
        renderToNodeStream(frontend)
      );

      stream.pipe(
        res,
        { end: false }
      );

      const bundles = getBundles(stats, modules)
        // Create <script defer> tags from bundle objects
        .map(bundle => `/${bundle.file.replace(/\.map$/, '')}`)
        // Make sure only unique bundles are included
        .filter((value, index, self) => self.indexOf(value) === index);
      debug('bundles used:', bundles.join(','));
      stream.on('end', () =>
        res.end(
          getFooter({
            state,
            data,
            bundles,
            nonce: nonce,
          })
        )
      );
    })
    .catch(err => {
      console.error(err);
      const sentryId =
        process.env.NODE_ENV === 'production'
          ? Raven.captureException(err)
          : 'Only output in production.';
      res.status(500);
      res.send(
        `Oops, something went wrong. Please try again! (Error ID: ${sentryId})`
      );
    });
};

export default renderer;
