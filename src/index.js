

// 音频转码worker
let recorderWorker = new Worker('./transformpcm.worker.js')
// 记录处理的缓存音频
let buffer = []
let AudioContext = window.AudioContext || window.webkitAudioContext
let notSupportTip = '请试用chrome浏览器且域名为localhost或127.0.0.1测试'
navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia


const powerLevel=(pcmAbsSum,pcmLength) => {
	/*计算音量 https://blog.csdn.net/jody1989/article/details/73480259
	更高灵敏度算法:
		限定最大感应值10000
			线性曲线：低音量不友好
				power/10000*100 
			对数曲线：低音量友好，但需限定最低感应值
				(1+Math.log10(power/10000))*100
	*/
	var power=(pcmAbsSum/pcmLength) || 0;//NaN
	var level;
	if(power<1251){//1250的结果10%，更小的音量采用线性取值
		level=Math.round(power/1250*10);
	}else{
		level=Math.round(Math.min(100,Math.max(0,(1+Math.log(power/10000)/Math.log(10))*100)));
	};
	return level;
};

const waveview = new WaveView({
  elem: '#localplayer',
  width: 600,
  height: 400
});

recorderWorker.onmessage = function (e) {
  buffer.push(...e.data.buffer);
  const buffers = e.data.buffer;
  const size=buffers.length;//块是共享的，必须复制出来
  const pcm=new Int16Array(size);
  let sum=0;
  for(let j=0;j<size;j++){//floatTo16BitPCM 
    let s=Math.max(-1,Math.min(1,buffers[j]));
    s=s<0?s*0x8000:s*0x7FFF;
    pcm[j]=s;
    sum+=Math.abs(s);
  };
  // powerLevel：当前缓冲的音量级别0-100。
  waveview.input(buffers,powerLevel(sum, pcm.length),32000);//输入音频数据，更新显示波形
}

class IatRecorder {
  constructor (config) {
    this.config = config
    this.state = 'ing'
    //以下信息在控制台-我的应用-实时语音转写 页面获取
    this.appId = 'ff67aabf' 
    this.apiKey = '583f4e89e777939a67242fdf0b9e147e'
  }

  start () {
    this.stop()
    if (navigator.getUserMedia && AudioContext) {
      this.state = 'ing'
      if (!this.recorder) {
        var context = new AudioContext()
        this.context = context
        this.recorder =context.createScriptProcessor(0, 1, 1)

        var getMediaSuccess = (stream) => {
          var mediaStream = this.context.createMediaStreamSource(stream)
          this.mediaStream = mediaStream
          this.recorder.onaudioprocess = (e) => {
            this.sendData(e.inputBuffer.getChannelData(0))
			
          }
          this.connectWebsocket()
        }
        var getMediaFail = (e) => {
          this.recorder = null
          this.mediaStream = null
          this.context = null
          console.log('请求麦克风失败')
        }
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
          }).then((stream) => {
            getMediaSuccess(stream)
          }).catch((e) => {
            getMediaFail(e)
          })
        } else {
          navigator.getUserMedia({
            audio: true,
            video: false
          }, (stream) => {
            getMediaSuccess(stream)
          }, function (e) {
            getMediaFail(e)
          })
        }
      } else {
        this.connectWebsocket()
      }
    } else {
      var isChrome = navigator.userAgent.toLowerCase().match(/chrome/)
      alert(notSupportTip)
    }
  }
    
  stop () {
    this.state = 'end'
    try {      
      this.mediaStream.disconnect(this.recorder)
      this.recorder.disconnect()
    } catch (e) {
      console.error(e);
    }
  }
  
  sendData (buffer) {
    recorderWorker.postMessage({
      command: 'transform',
      buffer: buffer
    })
  }
  // 生成握手参数
  getHandShakeParams() {
    var appId = this.appId
    var secretKey = this.apiKey
    var ts = Math.floor(new Date().getTime()/1000);//new Date().getTime()/1000+'';
    var signa = hex_md5(encodeURIComponent(appId + ts));//EncryptUtil.HmacSHA1Encrypt(EncryptUtil.MD5(appId + ts), secretKey);
    var signatureSha = CryptoJSNew.HmacSHA1(signa, secretKey)
    var signature = CryptoJS.enc.Base64.stringify(signatureSha)
    signature = encodeURIComponent(signature)
    return "?appid=" + appId + "&ts=" + ts + "&signa=" +signature;
  }
  connectWebsocket () {
    var url = 'wss://rtasr.xfyun.cn/v1/ws'
    var urlParam = this.getHandShakeParams()

     url = `${url}${urlParam}`
    if ('WebSocket' in window) {
      this.ws = new WebSocket(url)
    } else if ('MozWebSocket' in window) {
      this.ws = new MozWebSocket(url)
    } else {
      alert(notSupportTip)
      return null
    }
    this.ws.onopen = (e) => {
      this.mediaStream.connect(this.recorder)
      this.recorder.connect(this.context.destination)
      setTimeout(() => {
        this.wsOpened(e)
      }, 500)
      this.config.onStart && this.config.onStart(e)
    }
    this.ws.onmessage = (e) => {
      // this.config.onMessage && this.config.onMessage(e)
      this.wsOnMessage(e)
    }
    this.ws.onerror = (e) => {
      this.stop()
      console.log("关闭连接ws.onerror");
      this.config.onError && this.config.onError(e)
    }
    this.ws.onclose = (e) => {
      this.stop()
      console.log("关闭连接ws.onclose");
      $('.start-button').attr('disabled', false);
      this.config.onClose && this.config.onClose(e)
    }
  }
  
  wsOpened () {
    if (this.ws.readyState !== 1) {
      return
    }
    var audioData = buffer.splice(0, 1280)
    console.log(buffer, audioData);
    this.ws.send(new Int8Array(audioData))
    this.handlerInterval = setInterval(() => {
      // websocket未连接
      if (this.ws.readyState !== 1) {
        clearInterval(this.handlerInterval)
        return
      }
      if (buffer.length === 0) {
        if (this.state === 'end') {
          this.ws.send("{\"end\": true}")
          console.log("发送结束标识");
          clearInterval(this.handlerInterval)
        }
        return false
      }
      var audioData = buffer.splice(0, 1280)
      if(audioData.length > 0){
        this.ws.send(new Int8Array(audioData))
      }
    }, 40)
  }

  wsOnMessage(e){
    let jsonData = JSON.parse(e.data)
    if (jsonData.action == "started") {
      // 握手成功
      console.log("握手成功");
  } else if (jsonData.action == "result") {
      // 转写结果
      if(this.config.onMessage && typeof this.config.onMessage == 'function'){
        this.config.onMessage(jsonData.data)
      }
  } else if (jsonData.action == "error") {
      // 连接发生错误
      console.log("出错了:",jsonData);
  }
  }
  

  ArrayBufferToBase64 (buffer) {
    var binary = ''
    var bytes = new Uint8Array(buffer)
    var len = bytes.byteLength
    for (var i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return window.btoa(binary)
  }
}

class IatTaste {
  constructor () {
    var iatRecorder = new IatRecorder({
      onClose: () => {
        this.stop()
        this.reset()
      },
      onError: (data) => {
        this.stop()
        this.reset()
        alert('WebSocket连接失败')
      },
      onMessage: (message) =>{
        this.setResult(JSON.parse(message))
      },
      onStart: () => {
        $('hr').addClass('hr')
        var dialect = $('.dialect-select').find('option:selected').text()
        $('.taste-content').css('display', 'none')
        $('.start-taste').addClass('flex-display-1')
        $('.dialect-select').css('display', 'none')
        $('.start-button').text('结束转写')
        $('.time-box').addClass('flex-display-1')
        $('.dialect').text(dialect).css('display', 'inline-block')
        this.counterDown($('.used-time'))
      }
    })
    this.iatRecorder = iatRecorder
    this.counterDownDOM = $('.used-time')
    this.counterDownTime = 0

    this.text = {
      start: '开始转写',
      stop: '结束转写'
    }
    this.resultText = ''
  }

  start () {
    this.iatRecorder.start()
  }

  stop () {
    $('hr').removeClass('hr')
    this.iatRecorder.stop()
  }

  reset () {
    this.counterDownTime = 0
    clearTimeout(this.counterDownTimeout)
    buffer = []
    $('.time-box').removeClass('flex-display-1').css('display', 'none')
    $('.start-button').text(this.text.start)
    $('.dialect').css('display', 'none')
    $('.dialect-select').css('display', 'inline-block')
    $('.taste-button').css('background', '#0b99ff')
  }

  init () {
    let self = this
    //开始
    $('#taste_button').click(function () {
      if (navigator.getUserMedia && AudioContext && recorderWorker) {
        self.start()
      } else {
        alert(notSupportTip)
      }
    })
    //结束
    $('.start-button').click(function () {
      if ($(this).text() === self.text.start && !$(this).prop('disabled')) {
        $('#result_output').text('')
        self.resultText = ''
        self.start()
        //console.log("按钮非禁用状态，正常启动" + $(this).prop('disabled'))
      } else {
        //$('.taste-content').css('display', 'none')
        $('.start-button').attr('disabled', true);
        self.stop()
        //reset
        this.counterDownTime = 0
        clearTimeout(this.counterDownTimeout)
        buffer = []
        $('.time-box').removeClass('flex-display-1').css('display', 'none')
        $('.start-button').text('转写停止中...')
        $('.dialect').css('display', 'none')
        $('.taste-button').css('background', '#8E8E8E')
        $('.dialect-select').css('display', 'inline-block')
        
        //console.log("按钮非禁用状态，正常停止" + $(this).prop('disabled'))
      }
    })
  }
  setResult (data) {
    let rtasrResult = []
    var currentText = $('#result_output').html()
    rtasrResult[data.seg_id] = data
    console.log(rtasrResult, data);

    rtasrResult.forEach(i => {
      let str = "实时转写"
      str += (i.cn.st.type == 0) ? "【最终】识别结果：" : "【中间】识别结果："
      i.cn.st.rt.forEach(j => {
        j.ws.forEach(k => {
          k.cw.forEach(l => {
            str += l.w
          })
        })
      })
      if (currentText.length == 0) {
        $('#result_output').html(str)
      } else {
        $('#result_output').html(currentText + "<br>" +str)
      }
      var ele = document.getElementById('result_output');
      ele.scrollTop = ele.scrollHeight;
    })
  }

  counterDown () {
    /*//计时5分钟
    if (this.counterDownTime === 300) {
      this.counterDownDOM.text('05: 00')
      this.stop()
    } else if (this.counterDownTime > 300) {
      this.reset()
      return false
    } else */ 
    if (this.counterDownTime >= 0 && this.counterDownTime < 10) {
      this.counterDownDOM.text('00: 0' + this.counterDownTime)
    } else if (this.counterDownTime >= 10 && this.counterDownTime < 60) {
      this.counterDownDOM.text('00: ' + this.counterDownTime)
    } else if (this.counterDownTime%60 >=0 && this.counterDownTime%60 < 10) {
      this.counterDownDOM.text('0' + parseInt(this.counterDownTime/60) + ': 0' + this.counterDownTime%60)
    } else {
      this.counterDownDOM.text('0' + parseInt(this.counterDownTime/60) + ': ' + this.counterDownTime%60)
    }
    this.counterDownTime++
    this.counterDownTimeout = setTimeout(() => {
      this.counterDown()
    }, 1000)
  }
}
var iatTaste = new IatTaste()
iatTaste.init()