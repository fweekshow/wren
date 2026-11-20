// Privy's polyfills install WebCrypto before anything else runs. Keep this
// on the first line of the entry file — imports are hoisted in their source
// order, and everything downstream (fetch, viem, our SDK code) assumes crypto.
import '@privy-io/expo/polyfills';

import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
