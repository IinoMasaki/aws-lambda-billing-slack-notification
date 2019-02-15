'use strict';

const WebClient = require('@slack/client').WebClient;
const AWS = require('aws-sdk');
const moment = require('moment');

const cloudwatch = new AWS.CloudWatch({
  region: 'us-east-1',
  endpoint: 'http://monitoring.us-east-1.amazonaws.com'
});

const SLACK_API_TOKEN = process.env.SLACK_API_TOKEN;
const POST_CHANNEL    = process.env.POST_CHANNEL;

const listMetrics = () => {
  return new Promise((resolve, reject) => {
    cloudwatch.listMetrics({ MetricName: 'EstimatedCharges' }, (error, data) => {
      if (error) {
        reject(error)
      } else {
        resolve(data)
      }
    })
  })
};

const getMetricStatistics = (serviceName, startTime, endTime) => {
  const dimensions = [{ Name: 'Currency', Value: 'USD' }];
  if (serviceName) {
    dimensions.push({ Name: 'ServiceName', Value: serviceName })
  }
  return new Promise((resolve, reject) => {
    const params = {
      MetricName: 'EstimatedCharges',
      Namespace: 'AWS/Billing',
      Period: 86400,
      StartTime: startTime,
      EndTime: endTime,
      Statistics: ['Maximum'],
      Dimensions: dimensions
    };
    cloudwatch.getMetricStatistics(params, (error, data) => {
      if (error) {
        reject(error)
      } else {
        resolve({ name: serviceName, data: data })
      }
    })
  })
};

exports.handler = (event, context, callback) => {
  listMetrics().then(data => {
    const now = moment().toISOString();
    const yesterday = moment(now).subtract(1, 'd').toISOString();
    const promises = data['Metrics'].map(metric => {
      return metric['Dimensions'][0]
    }).filter(dimension => {
      return dimension['Name'] === 'ServiceName'
    }).map(dimension => {
      return dimension['Value']
    }).filter((serviceName, index, self) => {
      return self.indexOf(serviceName) === index
    }).map(serviceName => {
      return getMetricStatistics(serviceName, yesterday, now)
    });
    promises.unshift(getMetricStatistics(null, yesterday, now));
    Promise.all(promises).then(data => {
      const results = data.filter(result => {
        const datapoints = result.data['Datapoints'];
        return (datapoints.length !== 0 && datapoints[0]['Maximum'] !== 0)
      });
      if (results.length === 0) {
        return
      }
      const fields = results.filter(result => {
        return result.name != null
      }).sort((result1, result2) => {
        const charge1 = result1.data['Datapoints'][0]['Maximum'];
        const charge2 = result2.data['Datapoints'][0]['Maximum'];
        return (charge2 - charge1)
      }).map(result => {
        const datapoint = result.data['Datapoints'][0];
        return { title: result.name, value: `$${datapoint['Maximum']}`, short: true }
      });
      const datapoint = results[0].data['Datapoints'][0];
      const client = new WebClient(SLACK_API_TOKEN);
      client.chat.postMessage(POST_CHANNEL, `AWS料金 $${datapoint['Maximum']}`, { attachments: [{ color: 'good', fields: fields }] }, (error, response) => {
        if (error) { console.error(error) }
      })
    }, reason => {
      console.error(reason)
    })
  }, reason => {
    console.error(reason)
  })
};