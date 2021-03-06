"use strict"

class Network {

    constructor ({learningRate, layers=[], updateFn="vanillasgd", activation="sigmoid", cost="meansquarederror", momentum=0.9,
        rmsDecay, rho, lreluSlope, eluAlpha, dropout=1, l2, l1, maxNorm, weightsConfig, channels, conv, pool}={}) {

        this.state = "not-defined"
        this.layers = []
        this.conv = {}
        this.pool = {}
        this.epochs = 0
        this.iterations = 0
        this.validations = 0
        this.dropout = dropout==false ? 1 : dropout
        this.error = 0
        activation = NetUtil.format(activation)
        updateFn = NetUtil.format(updateFn)
        cost = NetUtil.format(cost)
        this.l1 = 0
        this.l2 = 0

        if (l1) {
            this.l1 = typeof l1=="boolean" ? 0.005 : l1
            this.l1Error = 0
        }

        if (l2) {
            this.l2 = typeof l2=="boolean" ? 0.001 : l2
            this.l2Error = 0
        }

        if (maxNorm) {
            this.maxNorm = typeof maxNorm=="boolean" && maxNorm ? 1000 : maxNorm
            this.maxNormTotal = 0
        }

        if (learningRate)   this.learningRate = learningRate
        if (channels)       this.channels = channels

        if (conv) {
            if (conv.filterSize!=undefined)     this.conv.filterSize = conv.filterSize
            if (conv.zeroPadding!=undefined)    this.conv.zeroPadding = conv.zeroPadding
            if (conv.stride!=undefined)         this.conv.stride = conv.stride
        }

        if (pool) {
            if (pool.size)      this.pool.size = pool.size
            if (pool.stride)    this.pool.stride = pool.stride
        }

        // Activation function / Learning Rate
        switch (updateFn) {

            case "rmsprop":
                this.learningRate = this.learningRate==undefined ? 0.001 : this.learningRate
                break

            case "adam":
                this.learningRate = this.learningRate==undefined ? 0.01 : this.learningRate
                break

            case "momentum":
                this.learningRate = this.learningRate==undefined ? 0.2 : this.learningRate
                this.momentum = momentum
                break

            case "adadelta":
                this.rho = rho==null ? 0.95 : rho
                break

            default:

                if (this.learningRate==undefined) {

                    switch (activation) {

                        case "relu":
                        case "lrelu":
                        case "rrelu":
                        case "elu":
                            this.learningRate = 0.01
                            break

                        case "tanh":
                        case "lecuntanh":
                            this.learningRate = 0.001
                            break

                        default:
                            this.learningRate = 0.2
                    }
                }
        }

        this.updateFn = [false, null, undefined].includes(updateFn) ? "vanillasgd" : updateFn
        this.weightUpdateFn = NetMath[this.updateFn]
        this.activation = typeof activation=="function" ? activation : NetMath[activation].bind(this)
        this.activationConfig = activation
        this.cost = typeof cost=="function" ? cost : NetMath[cost]

        if (this.updateFn=="rmsprop") {
            this.rmsDecay = rmsDecay==undefined ? 0.99 : rmsDecay
        }

        this.lreluSlope = lreluSlope==undefined ? -0.0005 : lreluSlope
        this.rreluSlope = Math.random() * 0.001
        this.eluAlpha = eluAlpha==undefined ? 1 : eluAlpha

        // Weights distributiom
        this.weightsConfig = {distribution: "xavieruniform"}

        if (weightsConfig != undefined && weightsConfig.distribution) {
            this.weightsConfig.distribution = NetUtil.format(weightsConfig.distribution)
        }

        if (this.weightsConfig.distribution == "uniform") {
            this.weightsConfig.limit = weightsConfig && weightsConfig.limit!=undefined ? weightsConfig.limit : 0.1

        } else if (this.weightsConfig.distribution == "gaussian") {
            this.weightsConfig.mean = weightsConfig.mean || 0
            this.weightsConfig.stdDeviation = weightsConfig.stdDeviation || 0.05
        }

        if (typeof this.weightsConfig.distribution=="function") {
            this.weightsInitFn = this.weightsConfig.distribution
        } else {
            this.weightsInitFn = NetMath[this.weightsConfig.distribution]
        }

        if (layers.length) {

            switch (true) {

                case layers.every(item => Number.isInteger(item)):
                    this.layers = layers.map(size => new FCLayer(size))
                    this.state = "constructed"
                    this.initLayers()
                    break

                case layers.every(layer => layer instanceof FCLayer || layer instanceof ConvLayer || layer instanceof PoolLayer):
                    this.state = "constructed"
                    this.layers = layers
                    this.initLayers()
                    break

                default:
                    throw new Error("There was an error constructing from the layers given.")
            }
        }

        this.collectedErrors = {training: [], validation: [], test: []}
    }

    initLayers (input, expected) {

        switch (this.state) {

            case "initialised":
                return

            case "not-defined":
                this.layers[0] = new FCLayer(input)
                this.layers[1] = new FCLayer(Math.ceil(input/expected > 5 ? expected + (Math.abs(input-expected))/4
                                                                          : input + expected))
                this.layers[2] = new FCLayer(Math.ceil(expected))
                break
        }

        this.layers.forEach(this.joinLayer.bind(this))

        const outSize = this.layers[this.layers.length-1].size
        this.trainingConfusionMatrix = [...new Array(outSize)].map(r => [...new Array(outSize)].map(v => 0))
        this.testConfusionMatrix = [...new Array(outSize)].map(r => [...new Array(outSize)].map(v => 0))
        this.validationConfusionMatrix = [...new Array(outSize)].map(r => [...new Array(outSize)].map(v => 0))

        this.state = "initialised"
    }

    joinLayer (layer, layerIndex) {

        layer.net = this
        layer.activation = layer.activation==undefined ? this.activation : layer.activation

        layer.weightsConfig = {}
        Object.assign(layer.weightsConfig, this.weightsConfig)

        if (layerIndex) {
            this.layers[layerIndex-1].assignNext(layer)
            layer.assignPrev(this.layers[layerIndex-1], layerIndex)

            layer.weightsConfig.fanIn = layer.prevLayer.size

            if (layerIndex<this.layers.length-1) {
                layer.weightsConfig.fanOut = this.layers[layerIndex+1].size
            }

            layer.init()

        } else if (this.layers.length > 1) {
            layer.weightsConfig.fanOut = this.layers[1].size
        }

        layer.state = "initialised"
    }

    forward (data) {

        if (this.state!="initialised") {
            throw new Error("The network layers have not been initialised.")
        }

        if (data === undefined || data === null) {
            throw new Error("No data passed to Network.forward()")
        }

        // Flatten volume inputs
        if (Array.isArray(data[0])) {
            const flat = []

            for (let c=0; c<data.length; c++) {
                for (let r=0; r<data[0].length; r++) {
                    for (let v=0; v<data[0].length; v++) {
                        flat.push(data[c][r][v])
                    }
                }
            }
            data = flat
        }

        if (data.length != this.layers[0].neurons.length) {
            console.warn("Input data length did not match input layer neurons count.")
        }

        this.layers[0].neurons.forEach((neuron, ni) => neuron.activation = data[ni])
        this.layers.forEach((layer, li) => li && layer.forward())

        return this.layers[this.layers.length-1].neurons.map(n => n.activation)
    }

    backward (errors) {

        if (errors === undefined) {
            throw new Error("No data passed to Network.backward()")
        }

        if (errors.length != this.layers[this.layers.length-1].neurons.length) {
            console.warn("Expected data length did not match output layer neurons count.", errors)
        }

        this.layers[this.layers.length-1].backward(errors)

        for (let layerIndex=this.layers.length-2; layerIndex>0; layerIndex--) {
            this.layers[layerIndex].backward()
        }
    }

    train (dataSet, {epochs=1, callback, callbackInterval=1, collectErrors, log=true, miniBatchSize=1, shuffle=false, validation}={}) {

        this.miniBatchSize = typeof miniBatchSize=="boolean" && miniBatchSize ? dataSet[0].expected.length : miniBatchSize
        this.validation = validation

        return new Promise((resolve, reject) => {

            if (shuffle) {
                NetUtil.shuffle(dataSet)
            }

            if (log) {
                console.log(`Training started. Epochs: ${epochs} Batch Size: ${this.miniBatchSize}`)
            }

            if (dataSet === undefined || dataSet === null) {
                return void reject("No data provided")
            }

            if (this.state != "initialised") {
                this.initLayers.bind(this, dataSet[0].input.length, (dataSet[0].expected || dataSet[0].output).length)()
            }

            this.layers.forEach(layer => layer.state = "training")

            if (this.validation) {
                this.validation.interval = this.validation.interval || dataSet.length // Default to 1 epoch

                if (this.validation.earlyStopping) {
                    switch (this.validation.earlyStopping.type) {
                        case "threshold":
                            this.validation.earlyStopping.threshold = this.validation.earlyStopping.threshold || 0.01
                            break
                        case "patience":
                            this.validation.earlyStopping.patienceCounter = 0
                            this.validation.earlyStopping.bestError = Infinity
                            this.validation.earlyStopping.patience = this.validation.earlyStopping.patience || 20
                            break
                        case "divergence":
                            this.validation.earlyStopping.percent = this.validation.earlyStopping.percent || 30
                            this.validation.earlyStopping.bestError = Infinity
                            break
                    }
                }
            }

            let iterationIndex = 0
            let epochsCounter = 0
            let elapsed
            const startTime = Date.now()

            const logAndResolve = () => {
                this.layers.forEach(layer => layer.state = "initialised")

                if (this.validation && this.validation.earlyStopping && (this.validation.earlyStopping.type == "patience" || this.validation.earlyStopping.type == "divergence")) {
                    for (let l=1; l<this.layers.length; l++) {
                        this.layers[l].restoreValidation()
                    }
                }

                if (log) {
                    console.log(`Training finished. Total time: ${NetUtil.format(elapsed, "time")}  Average iteration time: ${NetUtil.format(elapsed/iterationIndex, "time")}`)
                }
                resolve()
            }

            const doEpoch = () => {
                this.epochs++
                this.error = 0
                this.validationError = 0
                iterationIndex = 0

                if (this.l2Error!=undefined) this.l2Error = 0
                if (this.l1Error!=undefined) this.l1Error = 0

                doIteration()
            }

            const doIteration = async () => {

                if (!dataSet[iterationIndex].hasOwnProperty("input") || (!dataSet[iterationIndex].hasOwnProperty("expected") && !dataSet[iterationIndex].hasOwnProperty("output"))) {
                    return void reject("Data set must be a list of objects with keys: 'input' and 'expected' (or 'output')")
                }

                let trainingError
                let validationError

                const input = dataSet[iterationIndex].input
                const output = this.forward(input)
                const target = dataSet[iterationIndex].expected || dataSet[iterationIndex].output

                let classification = -Infinity
                const errors = []
                for (let n=0; n<output.length; n++) {
                    errors[n] = (target[n]==1 ? 1 : 0) - output[n]
                    classification = Math.max(classification, output[n])
                }

                if (this.trainingConfusionMatrix[target.indexOf(1)]) {
                    this.trainingConfusionMatrix[target.indexOf(1)][output.indexOf(classification)]++
                }

                // Do validation
                if (this.validation && iterationIndex && iterationIndex%this.validation.interval==0) {

                    validationError = await this.validate(this.validation.data)

                    if (this.validation.earlyStopping && this.checkEarlyStopping(errors)) {
                        log && console.log("Stopping early")
                        return logAndResolve()
                    }
                }

                this.backward(errors)

                if (++iterationIndex%this.miniBatchSize==0) {
                    this.applyDeltaWeights()
                    this.resetDeltaWeights()
                } else if (iterationIndex >= dataSet.length) {
                    this.applyDeltaWeights()
                }

                trainingError = this.cost(target, output)
                this.error += trainingError
                this.iterations++

                elapsed = Date.now() - startTime

                if (collectErrors) {
                    this.collectedErrors.training.push(trainingError)

                    if (validationError) {
                        this.collectedErrors.validation.push(validationError)
                    }
                }

                if ((iterationIndex%callbackInterval == 0 || validationError) && typeof callback=="function") {
                    callback({
                        iterations: this.iterations,
                        validations: this.validations,
                        validationError, trainingError,
                        elapsed, input
                    })
                }

                if (iterationIndex < dataSet.length) {

                    if (iterationIndex%callbackInterval == 0) {
                        setTimeout(doIteration.bind(this), 0)
                    } else {
                        doIteration()
                    }

                } else {
                    epochsCounter++

                    if (log) {
                        let text = `Epoch: ${this.epochs}\nTraining Error: ${this.error/iterationIndex}`

                        if (validation) {
                            text += `\nValidation Error: ${this.validationError}`
                        }

                        if (this.l2Error!=undefined) {
                            text += `\nL2 Error: ${this.l2Error/iterationIndex}`
                        }

                        text += `\nElapsed: ${NetUtil.format(elapsed, "time")} Average Duration: ${NetUtil.format(elapsed/epochsCounter, "time")}`
                        console.log(text)
                    }

                    if (epochsCounter < epochs) {
                        doEpoch()
                    } else {
                        logAndResolve()
                    }
                }
            }

            this.resetDeltaWeights()
            doEpoch()
        })
    }

    validate (data) {
        return new Promise((resolve, reject) => {
            let validationIndex = 0
            let totalValidationErrors = 0

            const validateItem = (item) => {

                const output = this.forward(data[validationIndex].input)
                const target = data[validationIndex].expected || data[validationIndex].output

                let classification = -Infinity
                for (let i=0; i<output.length; i++) {
                    classification = Math.max(classification, output[i])
                }

                if (this.validationConfusionMatrix[target.indexOf(1)]) {
                    this.validationConfusionMatrix[target.indexOf(1)][output.indexOf(classification)]++
                }

                this.validations++
                totalValidationErrors += this.cost(target, output)
                // maybe do this only once, as there's no callback anyway
                this.validationError = totalValidationErrors / (validationIndex+1)

                if (++validationIndex<data.length) {
                    setTimeout(() => validateItem(validationIndex), 0)
                } else {
                    this.lastValidationError = totalValidationErrors / data.length
                    resolve(totalValidationErrors / data.length)
                }
            }
            validateItem(validationIndex)
        })
    }

    checkEarlyStopping (errors) {

        let stop = false

        switch (this.validation.earlyStopping.type) {
            case "threshold":
                stop = this.lastValidationError <= this.validation.earlyStopping.threshold

                // Do the last backward pass
                if (stop) {
                    this.backward(errors)
                    this.applyDeltaWeights()
                }

                return stop

            case "patience":
                if (this.lastValidationError < this.validation.earlyStopping.bestError) {
                    this.validation.earlyStopping.patienceCounter = 0
                    this.validation.earlyStopping.bestError = this.lastValidationError

                    for (let l=1; l<this.layers.length; l++) {
                        this.layers[l].backUpValidation()
                    }

                } else {
                    this.validation.earlyStopping.patienceCounter++
                    stop = this.validation.earlyStopping.patienceCounter>=this.validation.earlyStopping.patience
                }
                return stop

            case "divergence":
                if (this.lastValidationError < this.validation.earlyStopping.bestError) {
                    this.validation.earlyStopping.bestError = this.lastValidationError

                    for (let l=1; l<this.layers.length; l++) {
                        this.layers[l].backUpValidation()
                    }
                } else {
                    stop = this.lastValidationError / this.validation.earlyStopping.bestError >= (1+this.validation.earlyStopping.percent/100)
                }

                return stop
        }
    }

    test (testSet, {log=true, callback, collectErrors}={}) {
        return new Promise((resolve, reject) => {

            if (testSet === undefined || testSet === null) {
                reject("No data provided")
            }

            if (log) {
                console.log("Testing started")
            }

            let totalError = 0
            let iterationIndex = 0
            const startTime = Date.now()

            const testInput = () => {

                const input = testSet[iterationIndex].input
                const output = this.forward(input)
                const target = testSet[iterationIndex].expected || testSet[iterationIndex].output
                const elapsed = Date.now() - startTime

                let classification = -Infinity
                for (let i=0; i<output.length; i++) {
                    classification = Math.max(classification, output[i])
                }

                if (this.testConfusionMatrix[target.indexOf(1)]) {
                    this.testConfusionMatrix[target.indexOf(1)][output.indexOf(classification)]++
                }

                const iterationError = this.cost(target, output)
                totalError += iterationError
                iterationIndex++

                if (collectErrors) {
                    this.collectedErrors.test.push(iterationError)
                }

                if (typeof callback=="function") {
                    callback({
                        iterations: iterationIndex,
                        error: iterationError,
                        elapsed, input
                    })
                }

                if (iterationIndex < testSet.length) {
                    setTimeout(testInput.bind(this), 0)

                } else {

                    if (log) {
                        console.log(`Testing finished. Total time: ${NetUtil.format(elapsed, "time")}  Average iteration time: ${NetUtil.format(elapsed/iterationIndex, "time")}`)
                    }

                    resolve(totalError/testSet.length)
                }
            }
            testInput()
        })
    }

    resetDeltaWeights () {
        this.layers.forEach((layer, li) => li && layer.resetDeltaWeights())
    }

    applyDeltaWeights () {

        this.layers.forEach((layer, li) => li && layer.applyDeltaWeights())

        if (this.maxNorm!=undefined) {
            this.maxNormTotal = Math.sqrt(this.maxNormTotal)
            NetMath.maxNorm.bind(this)()
        }
    }

    toJSON () {
        return {
            layers: this.layers.map(layer => layer.toJSON())
        }
    }

    fromJSON (data) {

        if (data === undefined || data === null) {
            throw new Error("No JSON data given to import.")
        }

        if (data.layers.length != this.layers.length) {
            throw new Error(`Mismatched layers (${data.layers.length} layers in import data, but ${this.layers.length} configured)`)
        }

        this.resetDeltaWeights()
        this.layers.forEach((layer, li) => li && layer.fromJSON(data.layers[li], li))
    }

    toIMG (IMGArrays, opts={}) {

        if (!IMGArrays) {
            throw new Error("The IMGArrays library must be provided. See the documentation for instructions.")
        }

        const data = []

        for (let l=1; l<this.layers.length; l++) {

            const layerData = this.layers[l].toIMG()
            for (let v=0; v<layerData.length; v++) {
                data.push(layerData[v])
            }
        }

        return IMGArrays.toIMG(data, opts)
    }

    fromIMG (rawData, IMGArrays, opts={}) {

        if (!IMGArrays) {
            throw new Error("The IMGArrays library must be provided. See the documentation for instructions.")
        }

        let valI = 0
        const data = IMGArrays.fromIMG(rawData, opts)

        for (let l=1; l<this.layers.length; l++) {

            const dataCount = this.layers[l].getDataSize()
            this.layers[l].fromIMG(data.splice(0, dataCount))
        }
    }

    printConfusionMatrix (type) {
        if (type) {
            NetUtil.printConfusionMatrix(NetUtil.makeConfusionMatrix(this[`${type}ConfusionMatrix`]))
        } else {
            // Total all data
            const data = []

            for (let r=0; r<this.trainingConfusionMatrix.length; r++) {
                const row = []
                for (let c=0; c<this.trainingConfusionMatrix.length; c++) {
                    row.push(this.trainingConfusionMatrix[r][c] + this.testConfusionMatrix[r][c] + this.validationConfusionMatrix[r][c])
                }
                data.push(row)
            }
            NetUtil.printConfusionMatrix(NetUtil.makeConfusionMatrix(data))
        }
    }

    static get version () {
        return "3.4.1"
    }
}

/* istanbul ignore next */
typeof window!="undefined" && (window.Network = Network)
exports.Network = Network