import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyCNkRYx0x-dcjPQJSGgCqugOJ17BwOpcDQ",
  authDomain: "claudish-6da10.firebaseapp.com",
  projectId: "claudish-6da10",
  storageBucket: "claudish-6da10.firebasestorage.app",
  messagingSenderId: "1095565486978",
  appId: "1:1095565486978:web:1ced13f51530bb9c1d3d9b",
  measurementId: "G-9PYJS4N8X9",
};

export const app = initializeApp(firebaseConfig);

// Analytics only works in browser, not during SSR/build
export const analytics = isSupported().then((supported) => (supported ? getAnalytics(app) : null));
