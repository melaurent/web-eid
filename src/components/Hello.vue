<template>
  <div class="hello">
    <transition name="fade">
      <p v-if="connected">Bonjour {{ID.firstName + ' ' + ID.lastName}}</p>
    </transition>
    <modal v-if="!connected" v-bind:title='modalTitle' modalid='connectModal'>
      <div slot="body">
        <md-button v-if="!eid" class="md-raised" v-on:click="onConnect">Select</md-button>
      </div>
      <div slot="footer">
        <md-progress v-if="eid" :md-progress="progress"></md-progress>
      </div>
    </modal>
    <img v-bind:src="idPhotoUrl"></img>
  </div>
</template>

<script>
import EID from '../eid';
import * as asn1js from 'asn1js';
import Modal from './Modal';

export default {
  components: {
    'modal': Modal
  },
  name: 'hello',
  data () {
    return {
      eid: null,
      photo: null,
      name: null,
      progress: 0,
      connected: false,
      modalTitle: 'Select a card reader'
    };
  },
  created () {
    console.log('created');
  },
  computed: {
    idPhotoUrl () {
      if (this.photo) {
        var urlCreator = window.URL || window.webkitURL;
        return urlCreator.createObjectURL(this.photo);
      } else {
        return '';
      }
    }
  },
  methods: {
    onConnect () {
      if (this.eid) {
        this.eid.exit();
        this.eid = null;
      }
      console.log(navigator);
      navigator.usb.requestDevice({filters: [{ vendorId: 0x1a44 }]})
      .then(selectedDevice => {
        this.eid = new EID(selectedDevice);
        this.eid.on('card-inserted', this.onCardInserted);
        this.eid.init().then(() => {
          this.modalTitle = 'En attente de carte eID';
        }).catch(e => {
          this.eid = null;
          throw e;
        });
      });
    },
    onCardInserted () {
      this.modalTitle = 'Lecture des données...';
      this.progress = 0;
      this.eid.idGetId().then(ID => {
        this.ID = ID;
        this.progress += 25;
      })
      .then(() => this.eid.idGetPhoto())
      .then(blob => {
        // this.photo = blob;
        this.progress += 25;
      })
      .then(() => this.eid.getCertificate(EID.CERT.SIGN))
      .then(data => {
        this.signCert = asn1js.fromBER(data);
        this.progress += 25;
      })
      .then(() => this.eid.getCertificate(EID.CERT.AUTH))
      .then(data => {
        this.authCert = asn1js.fromBER(data);
        this.progress += 25;
      })
      .then(() => {
        console.log('All loaded');
        this.progress = 100;
        this.connected = true;
      });
    }
  },
  watch: {

  }
};
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped>
h1, h2 {
  font-weight: normal;
}

ul {
  list-style-type: none;
  padding: 0;
}

li {
  display: inline-block;
  margin: 0 10px;
}

a {
  color: #42b983;
}
</style>
