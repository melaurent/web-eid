import APDU from './apdu';

export default class CCID {
  constructor (device) {
    this.interfaceNumber = null;
    this.device = device;
    this.ctx = {};
    this.ctx.bSeq = 0;
    this.TYPE_TO_CLASS = {
      80: CCID.NotifySlotChange,
      81: CCID.HardwareError
    };
    this.events = {};
  }

  on (e, cb) {
    this.events[e] = cb;
  }

  async init () {
    console.log(this.device);
    for (var i = 0; i < this.device.configurations.length; i++) {
      var conf = this.device.configurations[i];
      for (var j = 0; j < conf.interfaces.length; j++) {
        var inter = conf.interfaces[j];
        for (var k = 0; k < inter.alternates.length; k++) {
          var alt = inter.alternates[k];
          if (alt.interfaceClass === 11) {
            try {
              console.log(this.device);
              // await this.device.reset();
              // await this.device.selectConfiguration(conf.configurationValue);
              await this.device.claimInterface(inter.interfaceNumber);
              this.interfaceNumber = inter.interfaceNumber;
              try {
                await this.device.selectAlternateInterface(inter.interfaceNumber, alt.alternateSetting);
              } catch (e) {
                console.log('Failed to set interface setting', inter.interfaceNumber, alt.alternateSetting);
                console.log('Ignore and see');
              }
              // Now we retrieve the conf descriptor to get the CCID descriptor
              var setup = {
                requestType: 'standard',
                recipient: 'device',
                request: 0x06,
                value: 0x0200,
                index: conf.configurationValue
              };
              await this.device.controlTransferOut(setup);
              var res = await this.device.controlTransferIn(setup, 100);
              var totalLength = res.data.getUint16(2, true);
              var type = 0;
              var length = 0;
              var offset = 0;
              while (type !== 0x21 && offset + length < totalLength) {
                offset = offset + length;
                length = res.data.getUint8(offset);
                type = res.data.getUint8(offset + 1);
              }
              // No CCID descriptor found.
              if (type !== 0x21) {
                throw new Error('No CCID descriptor found');
              }
              this.parseDescriptor(res.data.buffer.slice(offset, offset + length));
              var transport = (this.ctx.desc.features & 0x00FF0000) >> 16;
              if (transport !== 0x02 && transport !== 0x04) {
                // We need to have at least short ADPU support
                throw new Error('Device not supported');
              }

              // Register interrupts
              for (var l = 0; l < alt.endpoints.length; l++) {
                var endpt = alt.endpoints[l];
                if (endpt.direction === 'in' && endpt.type === 'interrupt') {
                  this.interruptEndpoint = endpt.endpointNumber;
                  this.device.transferIn(this.interruptEndpoint, 5).then((res) => this.onInterrupt(res)).catch((err) => console.log(err));
                }
                if (endpt.direction === 'in' && endpt.type === 'bulk') {
                  this.bulkInEndpoint = endpt.endpointNumber;
                }
                if (endpt.direction === 'out' && endpt.type === 'bulk') {
                  this.bulkOutEndpoint = endpt.endpointNumber;
                }
              }
            } catch (e) {
              console.log(e);
              this.exit();
              throw e;
            }
            return;
          }
        }
      }
    }
    throw new Error('No smartcard interface found');
  }

  async exit () {
    if (this.interfaceNumber) {
      await this.device.releaseInterface(this.interfaceNumber);
      this.interfaceNumber = null;
    }
    this.device = null;
  }

  parseDescriptor (buffer) {
    var dv = new DataView(buffer);
    var desc = {};
    desc.length = dv.getUint8(0);
    desc.descriptorType = dv.getUint8(1);
    desc.cdCCID = dv.getUint16(2, true);
    desc.maxSlotIndex = dv.getUint8(4);
    desc.voltageSupport = dv.getUint8(5);
    desc.protocols = dv.getUint32(6, true);
    desc.defaultClock = dv.getUint32(10, true);
    desc.maximumClock = dv.getUint32(14, true);
    desc.numClockSupported = dv.getUint8(18);
    desc.dataRate = dv.getUint32(19, true);
    desc.maxDataRate = dv.getUint32(23, true);
    desc.numDataRatesSupported = dv.getUint8(27);
    desc.maxIFSD = dv.getUint32(28, true);
    desc.synchProtocols = dv.getUint32(32, true);
    desc.mechanical = dv.getUint32(36, true);
    desc.features = dv.getUint32(40, true);
    desc.maxCCIDMessageLength = dv.getUint32(44, true);
    desc.classGetResponse = dv.getUint8(48);
    desc.classEnvelope = dv.getUint8(49);
    desc.lcdLayout = dv.getUint16(50);
    desc.PINSupport = dv.getUint8(52);
    desc.maxCCIDBusySlots = dv.getUint8(53);
    this.ctx.desc = desc;
  }

  onInterrupt (res) {
    if (this.device == null) {
      return;
    }
    var msg = this.read(res.data);
    if (msg && msg.messageType === 80) {
      for (var i = 0; i < this.ctx.desc.maxSlotIndex + 1; i++) {
        var state = (msg.slotICCState & (1 << (i * 2))) >> (i * 2);
        var changed = (msg.slotICCState & (2 << (i * 2))) >> (i * 2) + 1;
        if (changed) {
          if (state && this.events['card-inserted']) {
            this.iccPowerOn(i).then(() => {
              this.events['card-inserted'](i);
            });
          } else if (!state && this.events['card-removed']) {
            this.events['card-removed'](i);
          }
        }
      }
    }
    this.device.transferIn(this.interruptEndpoint, 5).then((res) => this.onInterrupt(res)).catch((err) => console.log(err));
  }

  read (data) {
    var msgType = data.getUint8();
    if (msgType in this.TYPE_TO_CLASS) {
      var msg = new this.TYPE_TO_CLASS[msgType](data, this.ctx);
      return msg;
    }
    return null;
  }

  async getParameters (slot) {
    var msg = new CCID.GetParameters(slot, this.ctx);
    var data = msg.serialize();
    await this.device.transferOut(this.bulkOutEndpoint, data);
    var res = await this.device.transferIn(this.bulkInEndpoint, CCID.Parameters.MAX_LENGTH);
    msg = new CCID.Parameters(res.data, this.ctx);
    return msg;
  }

  async xfrBlock (slot, apdu) {
    if (apdu.isExtended()) {
      throw new Error('Extended APDU not supported');
    }
    var msg = new CCID.XfrBlock(slot, apdu, this.ctx);
    var data = msg.serialize();
    var res = await this.device.transferOut(this.bulkOutEndpoint, data);
    res = await this.device.transferIn(this.bulkInEndpoint, CCID.DataBlock.MAX_LENGTH);
    msg = new CCID.DataBlock(res.data, this.ctx);
    return msg;
  }

  async iccPowerOn (slot) {
    var msg = new CCID.IccPowerOn(slot, this.ctx);
    var data = msg.serialize();
    var res = await this.device.transferOut(this.bulkOutEndpoint, data);
    res = await this.device.transferIn(this.bulkInEndpoint, CCID.DataBlock.MAX_LENGTH);
    msg = new CCID.DataBlock(res.data, this.ctx);
    return msg;
  }

  async sendApdu (slot, cla, ins, p1, p2, data, le) {
    var apdu = new APDU(cla, ins, p1, p2, data, le);
    var msg = await this.xfrBlock(slot, apdu);
    apdu.decodeResult(msg.abData);
    return apdu;
  }
}

CCID.NotifySlotChange = class {
  constructor (data, ctx) {
    this.messageType = data.getUint8(0);
    if (this.messageType !== 0x50) {
      throw new Error('Invalid message type');
    }
    this.slotICCState = 0;
    var sltLen = Math.floor((((ctx.desc.maxSlotIndex + 1) * 2) + 7) / 8);
    for (var i = 0; i < sltLen; i++) {
      this.slotICCState = this.slotICCState ^ (data.getUint8(1 + i) << (i * 8));
    }
  }
};

CCID.HardwareError = class {
  constructor (data, ctx) {
    this.messageType = data.getUint8(0);
    if (this.messageType !== 0x51) {
      throw new Error('Invalid message type');
    }
    this.slot = data.getUint8(1);
    this.seq = data.getUint8(2);
    this.hardwareErrorCode = data.getUint8(3);
  }
};

CCID.Parameters = class {
  constructor (data, ctx) {
    this.bMessageType = data.getUint8(0);
    if (this.bMessageType !== 0x82) {
      throw new Error('Invalid message type');
    }
    this.dwLength = data.getUint32(1, true);
    this.bSlot = data.getUint8(5);
    this.bSeq = data.getUint8(6);
    this.bStatus = data.getUint8(7);
    this.bError = data.getUint8(8);
    this.bProtocolNum = data.getUint8(9);
    if (this.bProtocolNum === 0) {
      this.bmFindexDindex = data.getUint8(10);
      this.bmTCCKST0 = data.getUint8(11);
      this.bGuardTimeT0 = data.getUint8(12);
      this.bWaitingIntegerT0 = data.getUint8(13);
      this.bClockStop = data.getUint8(14);
    } else if (this.bProtocolNum === 1) {
      this.bmFindexDindex = data.getUint8(10);
      this.bmTCCKST1 = data.getUint8(11);
      this.bGuardTimeT1 = data.getUint8(12);
      this.bWaitingIntegerT1 = data.getUint8(13);
      this.bClockStop = data.getUint8(14);
      this.bIFSC = data.getUint8(15);
      this.bNadValue = data.getUint8(16);
    }
  }
};
CCID.Parameters.MAX_LENGTH = 17;

CCID.DataBlock = class {
  constructor (data, ctx) {
    this.bMessageType = data.getUint8(0);
    if (this.bMessageType !== 0x80) {
      throw new Error('Invalid message type');
    }
    this.dwLength = data.getUint32(1, true);
    this.bSlot = data.getUint8(5);
    this.bSeq = data.getUint8(6);
    this.bStatus = data.getUint8(7);
    this.bError = data.getUint8(8);
    this.bChainParameter = data.getUint8(8);
    this.abData = data.buffer.slice(10, 10 + this.dwLength);
  }
};
CCID.DataBlock.MAX_LENGTH = 2 + 10 + 255;

CCID.GetParameters = class {
  constructor (slot, ctx) {
    this.bMessageType = 108;
    this.dwLength = 0;
    this.bSlot = slot;
    this.bSeq = ctx.bSeq;
    this.abRFU = 0;
  }

  serialize () {
    var data = new DataView(new ArrayBuffer(10));
    data.setUint8(0, this.bMessageType);
    data.setUint32(1, this.dwLength, true);
    data.setUint8(5, this.bSlot);
    data.setUint8(6, this.bSeq);
    // TODO split abRFU into 3 bytes
    data.setUint16(7, this.abRFU, true);
    data.setUint8(9, this.abRFU);
    return data.buffer;
  }
};

CCID.XfrBlock = class {
  constructor (slot, apdu, ctx) {
    var data = apdu.getCommandAPDU();
    this.bMessageType = 0x6F;
    this.dwLength = data.byteLength;
    this.bSlot = slot;
    this.bSeq = ctx.seq++;
    this.bBWI = 10;
    this.wLevelParameter = 0x0000;
    this.abData = data;
  }
  serialize () {
    var dv = new DataView(new ArrayBuffer(10 + this.abData.byteLength));
    dv.setUint8(0, this.bMessageType);
    dv.setUint32(1, this.dwLength, true);
    dv.setUint8(5, this.dwSlot);
    dv.setUint8(6, this.bSeq);
    dv.setUint8(7, this.bBWI);
    dv.setUint16(8, this.wLevelParameter, true);
    var i = 10;
    var cdv = new DataView(this.abData);
    for (var k = 0; k < cdv.byteLength; k++) {
      dv.setUint8(i++, cdv.getUint8(k));
    }
    return dv.buffer;
  }
};

CCID.IccPowerOn = class {
  constructor (slot, ctx) {
    this.bMessageType = 0x62;
    this.dwLength = 0;
    this.bSlot = slot;
    this.bSeq = ctx.seq++;
    this.bPowerSelect = 0x00;
    this.abRFU = 0x00;
  }
  serialize () {
    var dv = new DataView(new ArrayBuffer(10));
    dv.setUint8(0, this.bMessageType);
    dv.setUint32(1, this.dwLength, true);
    dv.setUint8(5, this.bSlot);
    dv.setUint8(6, this.bSeq);
    dv.setUint8(7, this.bPowerSelect);
    dv.setUint16(8, this.abRFU, true);
    return dv.buffer;
  }
};

