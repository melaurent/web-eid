import Vue from 'vue';
import App from './App';
import router from './router';

var VueMaterial = require('vue-material');
Vue.use(VueMaterial);
Vue.config.productionTip = false;

console.log(navigator.usb);

/* eslint-disable no-new */
new Vue({
  el: '#app',
  router,
  template: '<App/>',
  components: { App }
});

