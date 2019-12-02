import CCID from './ccid';
import APDU from './apdu';

export default class EID {
  // EID files:
  // cardid: The id of the card
  // cardcf: ?
  // cardapps: Apps on the card
  // mscp/cmapfile: ?
  // mscp/msroots: ?
  // mscp/ksc00: Certificate
  // mscp/ksc01: Certificate
  // id/id
  // id/id_sign
  // id/addr
  // id/addr_sign
  constructor (device) {
    this.device = device;
    this.events = {};
    this.slot = null;
    this.card = null;
    this.CCID = new CCID(device);
    this.CCID.on('card-inserted', (slot) => {
      if (this.slot) {
        // Discard new card insertion if last one not removed
        return;
      }
      this.slot = slot;
      console.log('card-inserted');
      this.card = {};
      this.fetchCardData().then(() => {
        if (this.events['card-inserted']) {
          this.events['card-inserted']();
        }
      });
    });
    this.CCID.on('card-removed', (slot) => {
      this.slot = null;
      this.card = null;
      console.log('card-removed');
      if (this.events['card-removed']) {
        this.events['card-removed']();
      }
    });
  }

  Utf8ArrayToStr (array, offset, len) {
    var out, i, c;
    var char2, char3;

    out = '';
    i = offset;
    while (i < len) {
      c = array[i++];
      switch (c >> 4) {
        case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
          // 0xxxxxxx
          out += String.fromCharCode(c);
          break;
        case 12: case 13:
          // 110x xxxx   10xx xxxx
          char2 = array[i++];
          out += String.fromCharCode(((c & 0x1F) << 6) | (char2 & 0x3F));
          break;
        case 14:
          // 1110 xxxx  10xx xxxx  10xx xxxx
          char2 = array[i++];
          char3 = array[i++];
          out += String.fromCharCode(((c & 0x0F) << 12) |
                          ((char2 & 0x3F) << 6) |
                          ((char3 & 0x3F) << 0));
          break;
      }
    }
    return out;
  }

  on (e, cb) {
    this.events[e] = cb;
  }

  async verifyPin (pin) {
    var res = await this.CCID.sendApdu(this.slot, 0x00, APDU.INS_VERIFY, 0x00, 0x01, pin.encode());
    switch (res.getSW()) {
      case APDU.SW_OK:
        console.log('ok');
        break;
      case APDU.SW_WARNING2LEFT:
        console.log('Two tries left');
        break;
      case APDU.SW_WARNING1LEFT:
        console.log('One try left');
        break;
    }
  }

  async selectFile (fileId) {
    if (this.slot === null) {
      throw new Error('No card inserted');
    }
    var apdu = await this.CCID.sendApdu(this.slot, 0x00, APDU.INS_SELECT, 0x08, 0x0C, fileId.buffer);
    if (apdu.getSW() !== APDU.SW_OK) {
      console.log(apdu.getSW());
      throw new Error('Error occured while selecting file');
    }
  }

  async readFile () {
    if (this.slot === null) {
      throw new Error('No card inserted');
    }
    var data = new Uint8Array(0);
    var ndata;
    var offset = 0;
    while (true) {
      var apdu = await this.CCID.sendApdu(this.slot, 0x00, APDU.INS_READ_BINARY, (offset & 0xFF00) >> 8, (offset & 0x00FF), EID.READ_BINARY_MAX_LEN);
      if (apdu.getSW() !== APDU.SW_OK) {
        if (apdu.getSW1() === 0x6C) {
          // End of file, just need to retry with SW2 bytes instead
          apdu = await this.CCID.sendApdu(this.slot, 0x00, APDU.INS_READ_BINARY, (offset & 0xFF00) >> 8, (offset & 0x00FF), apdu.getSW2());
          if (apdu.getSW() !== APDU.SW_OK) {
            console.log(apdu.getSW());
            throw new Error('Error reading file');
          }
          ndata = new Uint8Array(data.byteLength + apdu.rdata.byteLength);
          ndata.set(data);
          ndata.set(new Uint8Array(apdu.rdata), data.byteLength);
          data = ndata;
          return data.buffer;
        } else {
          console.log(apdu.getSW());
          throw new Error('Error reading file');
        }
      }
      ndata = new Uint8Array(data.byteLength + apdu.rdata.byteLength);
      ndata.set(data);
      ndata.set(new Uint8Array(apdu.rdata), data.byteLength);
      data = ndata;
      offset += EID.READ_BINARY_MAX_LEN;
      if (apdu.rdata.byteLength < EID.READ_BINARY_MAX_LEN) {
        // No error and got less than we asked, EOF reached
        return data.buffer;
      }
    }
  }

  async fetchCardData () {
    if (this.slot === null) {
      throw new Error('No card inserted');
    }
    var apdu = await this.CCID.sendApdu(this.slot, EID.APDU_CLASS, EID.INS_GET_CARD_DATA, 0x00, 0x00, 0x1C);
    if (apdu.getSW() !== APDU.SW_OK) {
      throw new Error('Error fetching card data', apdu.getSW());
    }

    var dv = new Uint8Array(apdu.rdata);
    this.card.serialNr = apdu.rdata.slice(0, 16);
    this.card.appletVersion = dv[21];
  }

  async getFile (path) {
    if (!(path in EID.PATH_TO_FILE_ID)) {
      throw new Error('File not found');
    }
    var fileId = EID.PATH_TO_FILE_ID[path];
    await this.selectFile(fileId);
    var data = await this.readFile();
    return data;
  }

  async idGetPhoto () {
    var data = await this.getFile('/id/photo');
    var array = new Uint8Array(data);
    var blob = new Blob([array], { type: 'image/jpeg' });
    return blob;
  }

  parseId (array, ind) {
    var i = this.parseInd;
    while (array[i] !== ind) {
      i++;
    }
    var j = i + 2;
    while (array[j] !== ind + 1) {
      j++;
    }
    this.parseInd = j;
    return this.Utf8ArrayToStr(array, i + 2, j);
  }

  async idGetId () {
    this.parseInd = 0;
    var data = await this.getFile('/id/id');
    var array = new Uint8Array(data);
    var id = {};
    id.cardNumber = this.parseId(array, 0x01);
    id.chipNumber = this.parseId(array, 0x02);
    id.cardValidityBegin = this.parseId(array, 0x03);
    id.cardValidityEnd = this.parseId(array, 0x04);
    id.cardDeliveryMunicipality = this.parseId(array, 0x05);
    id.nationalNumber = this.parseId(array, 0x06);
    id.lastName = this.parseId(array, 0x07);
    id.firstName = this.parseId(array, 0x08);
    id.thirdName = this.parseId(array, 0x09);
    id.nationality = this.parseId(array, 0x0A);
    id.birthLocation = this.parseId(array, 0x0B);
    id.birthDate = this.parseId(array, 0x0C);
    id.sex = this.parseId(array, 0x0D);
    id.nobleCondition = this.parseId(array, 0x0E);
    id.documentType = this.parseId(array, 0x0F);
    id.specialStatus = this.parseId(array, 0x10);
    id.photoHash = this.parseId(array, 0x11);
    return id;
  }

  async idGetAddress () {
    var data = await this.getFile('/id/addr');
    var array = new Uint8Array(data);
    var str = String.fromCharCode.apply(null, array);
    str = decodeURIComponent(escape(str));
    return str;
  }

  async getCertificate (cert) {
    var file;
    switch (cert) {
      case EID.CERT.AUTH:
        file = '/mscp/ksc00';
        break;
      case EID.CERT.SIGN:
        file = '/mscp/ksc01';
        break;
    }
    var data = await this.getFile(file);
    return data;
  }

  async init () {
    await this.device.open();
    try {
      await this.CCID.init();
    } catch (e) {
      await this.exit();
      throw e;
    }
  }

  async exit () {
    await this.CCID.exit();
    await this.device.close();
  }
};

EID.READ_BINARY_MAX_LEN = 0xFF;
EID.PATH_TO_FILE_ID = {
  '/id/id': new Uint8Array([0x3f, 0x00, 0xdf, 0x01, 0x40, 0x31]),
  '/id/id_sgn': new Uint8Array([0x3f, 0x00, 0xdf, 0x01, 0x40, 0x32]),
  '/id/addr': new Uint8Array([0x3F, 0x00, 0xDF, 0x01, 0x40, 0x33]),
  '/id/addr_sgn': new Uint8Array([0x3F, 0x00, 0xDF, 0x01, 0x40, 0x34]),
  '/id/photo': new Uint8Array([0x3F, 0x00, 0xDF, 0x01, 0x40, 0x35]),
  '/id/photo_sgn': new Uint8Array([0x3F, 0x00, 0xDF, 0x01, 0x40, 0x36]),
  '/mscp/ksc00': new Uint8Array([0x3F, 0x00, 0xDF, 0x00, 0x50, 0x38]),
  '/mscp/ksc01': new Uint8Array([0x3F, 0x00, 0xDF, 0x00, 0x50, 0x39])
};

EID.Pin = class {
  constructor (digits) {
    this.data = new ArrayBuffer(8);
    var dv = new DataView(this.data);
    for (var i = 0; i < 8; i++) {
      dv.setUint8(i, 0xFF);
    }
    dv.setUint8(0, 0x20 ^ digits.length);
    for (i = 0; i < digits.length; i++) {
      var ind = Math.floor(1 + i / 2);
      if (i % 2 === 0) {
        dv.setUint8(ind, (dv.getUint8(ind) & 0x0F) ^ (digits[i] << 4));
      } else {
        dv.setUint8(ind, (dv.getUint8(ind) & 0xF0) ^ (digits[i]));
      }
    }
  }

  encode () {
    return this.data;
  }
};

EID.APDU_CLASS = 0x80;
EID.INS_GET_CARD_DATA = 0xE4;

EID.CERT = {
  AUTH: 0,
  SIGN: 1,
  CA: 2,
  ROOTCA: 3
};
