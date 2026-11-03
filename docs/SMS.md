# AWS SMS: slanje preko SNS-a

Prijava i povezivanje broja koriste `PhoneOtpService` i SNS `PublishCommand`.
Kod traje 10 minuta; provera koda ne salje novu poruku. SMS ostaje u sandboxu
dok korisnik izricito ne odobri prelazak u produkciju.

## Potrebne dozvole

Samo `sns:Publish` nije dovoljno. IAM korisnik aplikacije mora imati i
`sms-voice:SendTextMessage` kada poziv dolazi preko SNS-a. Za DAJA sender ID:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sns:Publish",
      "Resource": "*"
    },
    {
      "Sid": "SendDajaShopSmsViaSns",
      "Effect": "Allow",
      "Action": "sms-voice:SendTextMessage",
      "Resource": "arn:aws:sms-voice:eu-north-1:877348951940:sender-id/DAJASHOP/RS",
      "Condition": {
        "StringEquals": {
          "aws:CalledViaLast": "sns.amazonaws.com"
        }
      }
    }
  ]
}
```

Sender ID zasebno mora imati resource policy koji dozvoljava
`sns.amazonaws.com` akciju `sms-voice:SendTextMessage`, uz
`aws:SourceAccount=877348951940`. Ovo je potrebno i unutar istog AWS naloga.

Render API i worker koriste `SNS_SMS_REGION=eu-north-1`,
`SNS_SMS_SENDER_ID=DAJASHOP`, `SNS_SMS_ACCESS_KEY_ID` i
`SNS_SMS_SECRET_ACCESS_KEY`. Promena kljuceva nije potrebna za dopunu politike.
Stvarne runtime vrednosti proveriti zasebno; render.yaml nije dokaz njihove vrednosti.

## Nalaz 03.11.2026.

- SNS sandbox ima jedan verifikovan broj; broj uvek proveriti u konzoli.
- Sender ID `DAJASHOP/RS` postoji i ima SNS resource policy.
- IAM `dajashop-ses-sender` / `DajaShopSnsPublishOnly` je korisnik sacuvao
  03.11.2026; konzola potvrdjuje dopunu `SendDajaShopSmsViaSns` iznad.
  Politika dozvoljava slanje samo kroz SNS, sa sender ID-a `DAJASHOP/RS`.
- CloudWatch failure log od 28.10.2026. navodi odbijen pristup resursima.
  Jedan pokusaj ide na verifikovan broj, drugi na razlicit broj.
- SMS Protect konfiguracije ne postoje; SMS limit je 1 USD, potrosnja 0 USD.
- Fizicka isporuka i rad produkcijskog API-ja nisu potvrdjeni slanjem poruke.

Izvori: [SNS IAM dozvole](https://docs.aws.amazon.com/sns/latest/dg/security-iam-awsmanpol.html),
[deljenje sender ID-a sa SNS-om](https://docs.aws.amazon.com/sms-voice/latest/userguide/shared-resources.html).
