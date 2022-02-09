import React, { useEffect, useRef, useState } from 'react';
import { contracts, ftFeeContracts, nftFeeContracts, NETWORK } from '../lib/constants';
import { TxStatus } from './TxStatus';
import { cvToString, noneCV, someCV, standardPrincipalCV, uintCV } from 'micro-stacks/clarity';
import {
  AnchorMode,
  createAssetInfo,
  NonFungibleConditionCode,
  PostConditionMode,
  FungibleConditionCode,
  makeContractFungiblePostCondition,
  makeContractNonFungiblePostCondition,
  makeContractSTXPostCondition,
  makeStandardFungiblePostCondition,
  makeStandardNonFungiblePostCondition,
  makeStandardSTXPostCondition,
} from 'micro-stacks/transactions';

import { useAuth, useContractCall, useSession } from '@micro-stacks/react';
import { Address } from './Address';
import { AssetIcon } from './AssetIcon';
import { BANANA_TOKEN, getAsset, getAssetName } from './assets';
import { btcAddressToPubscriptCV } from '../lib/btcTransactions';
import { BN } from 'bn.js';
import { saveTxData } from '../lib/transactions';
import { Price } from './Price';
import { resolveBNS } from '../lib/account';
import { getFTData, getNFTData } from '../lib/tokenData';
import { contractToFees } from '../lib/fees';
import {
  buyAssetFromType,
  buyAssetIdFromType,
  buyAssetTypeFromSwapType,
  buyDecimalsFromType,
  factorForType,
  isAtomic,
  splitAssetIdentifier,
} from '../lib/assets';
import { makeCancelSwapPostConditions, makeCreateSwapPostConditions } from '../lib/swaps';
import { serializeCV } from 'micro-stacks/clarity';

function readFloat(ref) {
  const result = parseFloat(ref.current.value.trim());
  return isNaN(result) ? undefined : result;
}

function nftSwap(type) {
  return type === 'nft' || type === 'stx-nft' || type === 'banana-nft';
}

export function SwapCreate({ ownerStxAddress, type, trait, id, formData: formData1, blockHeight }) {
  const amountSatsRef = useRef();
  const assetSellerRef = useRef();
  const nftIdRef = useRef();
  const amountRef = useRef();
  const assetBuyerRef = useRef();
  const traitRef = useRef();
  const feeContractRef = useRef();
  const [txId, setTxId] = useState();
  const [loading, setLoading] = useState();
  const [status, setStatus] = useState();
  const [formData, setFormData] = useState(formData1);
  const [ftData, setFtData] = useState();

  const contract = contracts[type];
  const { handleContractCall } = useContractCall({
    contractAddress: contract.address,
    contractName: contract.name,
    network: NETWORK,
    anchorMode: AnchorMode.Any,
  });
  const { handleSignIn } = useAuth();
  const [userSession] = useSession();

  const atomicSwap = isAtomic(type);

  useEffect(() => {
    console.log({ type, formData });
    if (type === 'stx-ft' && formData && formData.trait) {
      const [contractId] = formData.trait.split('::');
      const [address, name] = contractId.split('.');
      getFTData(address, name).then(result => {
        console.log({ ftData: result });
        setFtData(result);
      });
    } else if (type === 'stx-nft' && formData && formData.trait) {
      const [contractId] = formData.trait.split('::');
      const [address, name] = contractId.split('.');
      getNFTData(address, name).then(result => {
        console.log({ nftData: result });
      });
    }
  }, [formData, type]);

  const createAction = async () => {
    setLoading(true);
    setStatus('');
    const errors = [];
    if (!atomicSwap && assetSellerRef.current.value.trim() === '') {
      errors.push('BTC address is required');
    }
    const factor = factorForType(type);
    const amountInputFloat = readFloat(amountSatsRef) || 0;
    const satsOrUstxCV = uintCV(BigInt(Math.floor(amountInputFloat * factor)));
    if (satsOrUstxCV.value <= 0) {
      errors.push('positive amount required to swap');
    }
    if (isNaN(parseInt(formData.nftId))) {
      errors.push('not a valid NFT id');
    }
    if (!traitRef.current.value.trim()) {
      errors.push('Missing token contract');
    }
    if (errors.length > 0) {
      setLoading(false);
      setStatus(
        errors.map((e, index) => (
          <React.Fragment key={index}>
            {e}
            <br />
          </React.Fragment>
        ))
      );
      return;
    }

    const seller = await resolveBNS(assetSellerRef.current.value.trim());
    const sellerCV = atomicSwap
      ? seller
        ? someCV(standardPrincipalCV(seller))
        : noneCV()
      : btcAddressToPubscriptCV(seller);
    const assetBuyer = await resolveBNS(assetBuyerRef.current.value.trim());

    let functionArgs, postConditions;
    let ftAmountCV, nftIdCV;
    let feeId, feeContract, feesCV, fees;
    let assetContractAddress, assetContractName, assetName, assetContractCV;
    switch (type) {
      case 'nft':
        if (!assetBuyer) {
          setStatus('Buyer address must be set.');
          setLoading(false);
          return;
        }
        nftIdCV = uintCV(nftIdRef.current.value.trim());
        const nftReceiverCV = standardPrincipalCV(assetBuyer);
        [assetContractCV, assetName, assetContractName, assetContractAddress] =
          splitAssetIdentifier(traitRef.current.value.trim());
        if (!assetName) {
          setLoading(false);
          setStatus('"nft contract :: nft name" must be set');
          return;
        }
        functionArgs = [satsOrUstxCV, sellerCV, nftIdCV, nftReceiverCV, assetContractCV];
        postConditions = [
          makeStandardNonFungiblePostCondition(
            ownerStxAddress,
            NonFungibleConditionCode.DoesNotOwn,
            createAssetInfo(assetContractAddress, assetContractName, assetName),
            nftIdCV
          ),
        ];
        break;
      case 'ft':
        ftAmountCV = uintCV(amountRef.current.value.trim());
        if (ftAmountCV.value <= 0) {
          setLoading(false);
          setStatus('positive numbers required to swap');
          return;
        }
        const ftReceiverCV = assetBuyer ? someCV(standardPrincipalCV(assetBuyer)) : noneCV();
        [assetContractCV, assetName, assetContractName, assetContractAddress] =
          splitAssetIdentifier(traitRef.current.value.trim());
        if (!assetName) {
          setLoading(false);
          setStatus('"ft contract :: ft name" must be set');
          return;
        }

        functionArgs = [satsOrUstxCV, sellerCV, ftAmountCV, ftReceiverCV, assetContractCV];
        postConditions = [
          makeStandardFungiblePostCondition(
            ownerStxAddress,
            FungibleConditionCode.Equal,
            ftAmountCV.value,
            createAssetInfo(assetContractAddress, assetContractName, assetName)
          ),
        ];
        break;
      case 'stx':
        const stxAmountCV = uintCV(amountRef.current.value.trim() * 1_000_000);
        if (stxAmountCV.value <= 0) {
          setLoading(false);
          setStatus('positive numbers required to swap');
          return;
        }
        const stxReceiverCV = assetBuyer ? someCV(standardPrincipalCV(assetBuyer)) : noneCV();
        functionArgs = [satsOrUstxCV, sellerCV, stxAmountCV, stxReceiverCV];
        postConditions = [
          makeStandardSTXPostCondition(
            ownerStxAddress,
            FungibleConditionCode.Equal,
            stxAmountCV.value
          ),
        ];
        break;
      case 'stx-ft':
        const sellFactor =
          formData.trait === 'SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X.friedger-token-v1::friedger'
            ? Math.pow(10, 6)
            : ftData
            ? Math.pow(10, ftData.decimals)
            : 1;
        ftAmountCV = uintCV(amountRef.current.value.trim() * sellFactor);
        if (ftAmountCV.value <= 0) {
          setLoading(false);
          setStatus('positive numbers required to swap');
          return;
        }
        [assetContractCV, assetName] = splitAssetIdentifier(traitRef.current.value.trim());
        if (!assetName) {
          setLoading(false);
          setStatus('"ft contract :: ft name" must be set');
          return;
        }
        feeId = feeContractRef.current.value;
        feeContract = ftFeeContracts[feeId];
        [feesCV, fees] = await contractToFees(feeContract, satsOrUstxCV);
        functionArgs = [satsOrUstxCV, ftAmountCV, sellerCV, assetContractCV, feesCV];
        postConditions = makeCreateSwapPostConditions(
          feeId,
          ownerStxAddress,
          satsOrUstxCV,
          fees,
          feeContract
        );
        break;
      case 'stx-nft':
        nftIdCV = uintCV(BigInt(nftIdRef.current.value.trim()));
        if (nftIdCV.value <= 0) {
          setLoading(false);
          setStatus('positive numbers required to swap');
          return;
        }
        [assetContractCV, assetName] = splitAssetIdentifier(traitRef.current.value.trim());
        if (!assetName) {
          setLoading(false);
          setStatus('"nft contract :: nft name" must be set');
          return;
        }
        feeId = feeContractRef.current.value;
        console.log({ feeId });
        feeContract = nftFeeContracts[feeId];
        [feesCV, fees] = await contractToFees(feeContract, satsOrUstxCV);
        functionArgs = [satsOrUstxCV, nftIdCV, sellerCV, assetContractCV, feesCV];
        postConditions = makeCreateSwapPostConditions(
          feeId,
          ownerStxAddress,
          satsOrUstxCV,
          fees,
          feeContract
        );
        break;
      case 'banana-nft':
        nftIdCV = uintCV(formData.nftId);
        if (nftIdCV.value <= 0) {
          setLoading(false);
          setStatus('positive numbers required to swap');
          return;
        }
        console.log(nftIdCV);
        console.log(serializeCV(nftIdCV));
        [assetContractCV, assetName] = splitAssetIdentifier(traitRef.current.value.trim());
        if (!assetName) {
          setLoading(false);
          setStatus('"nft contract :: nft name" must be set');
          return;
        }
        feeId = feeContractRef.current.value;
        console.log({ feeId });
        feeContract = nftFeeContracts[feeId];
        [feesCV, fees] = await contractToFees(feeContract, satsOrUstxCV);
        functionArgs = [satsOrUstxCV, nftIdCV, sellerCV, assetContractCV, feesCV];
        postConditions = makeCreateSwapPostConditions(
          feeId,
          ownerStxAddress,
          satsOrUstxCV,
          fees,
          feeContract
        );
        break;
      default:
        break;
    }
    await handleContractCall({
      functionName: 'create-swap',
      functionArgs,
      postConditionMode: PostConditionMode.Deny,
      postConditions,

      onCancel: () => {
        setLoading(false);
      },
      onFinish: result => {
        setStatus('Saving transaction to your storage');
        setTxId(result.txId);
        saveTxData(result, userSession)
          .then(r => {
            setLoading(false);
            setStatus(undefined);
          })
          .catch(e => {
            console.log(e);
            setLoading(false);
            setStatus("Couldn't save the transaction");
          });
      },
    });
  };

  const setRecipientAction = async () => {
    setLoading(true);
    const errors = [];
    if (assetBuyerRef.current.value.trim() === '') {
      errors.push('Receiver is required');
    }
    if (errors.length > 0) {
      setLoading(false);
      setStatus(
        errors.map((e, index) => (
          <React.Fragment key={index}>
            {e}
            <br />
          </React.Fragment>
        ))
      );
      return;
    }
    let functionArgs;
    let postConditions;
    let functionName;
    let idCV;
    switch (type) {
      case 'nft':
        setStatus('not supported');
        return;
      case 'ft':
        functionName = 'set-ft-receiver';
        idCV = uintCV(id);
        functionArgs = [idCV];
        postConditions = [];
        break;
      case 'stx':
        functionName = 'set-stx-receiver';
        idCV = uintCV(id);
        functionArgs = [idCV];
        postConditions = [];
        break;

      default:
        break;
    }
    await handleContractCall({
      functionName,
      functionArgs,
      postConditionMode: PostConditionMode.Deny,
      postConditions,

      onCancel: () => {
        setLoading(false);
      },
      onFinish: result => {
        setLoading(false);
        setTxId(result.txId);
      },
    });
  };

  const cancelAction = async () => {
    setLoading(true);
    const swapIdCV = uintCV(id);

    let functionArgs;
    let postConditions;
    let amountInSmallestUnit, nftIdCV;
    let assetContractCV, assetName, assetContractName, assetContractAddress;
    let feeId, feeContract, feesCV, fees;
    switch (type) {
      case 'nft':
        nftIdCV = uintCV(nftIdRef.current.value.trim());
        [, assetName, assetContractName, assetContractAddress] = splitAssetIdentifier(
          traitRef.current.value.trim()
        );
        functionArgs = [swapIdCV];
        postConditions = [
          makeContractNonFungiblePostCondition(
            contract.address,
            contract.name,
            NonFungibleConditionCode.DoesNotOwn,
            createAssetInfo(assetContractAddress, assetContractName, assetName),
            nftIdCV
          ),
        ];

        break;
      case 'ft':
        [, assetName, assetContractName, assetContractAddress] = splitAssetIdentifier(
          traitRef.current.value.trim()
        );
        amountInSmallestUnit = formData.amount * Math.pow(10, sellDecimals);
        functionArgs = [swapIdCV];
        postConditions = [
          makeContractFungiblePostCondition(
            contract.address,
            contract.name,
            FungibleConditionCode.Equal,
            new BN(amountInSmallestUnit),
            createAssetInfo(assetContractAddress, assetContractName, assetName)
          ),
        ];
        break;
      case 'stx':
        amountInSmallestUnit = formData.amount * Math.pow(10, sellDecimals);

        functionArgs = [swapIdCV];
        postConditions = [
          makeContractSTXPostCondition(
            contract.address,
            contract.name,
            FungibleConditionCode.Equal,
            new BN(amountInSmallestUnit)
          ),
        ];
        break;
      case 'stx-ft':
        const factor = 1_000_000;
        const satsOrUstxCV = uintCV(
          Math.floor(parseFloat(amountSatsRef.current.value.trim()) * factor)
        );

        [assetContractCV, assetName, assetContractName, assetContractAddress] =
          splitAssetIdentifier(traitRef.current.value.trim());
        if (!assetName) {
          setLoading(false);
          setStatus('"ft contract :: ft name" must be set');
          return;
        }
        feeId = feeContractRef.current.value;
        feeContract = ftFeeContracts[feeId];
        [feesCV, fees] = await contractToFees(feeContract, satsOrUstxCV);
        functionArgs = [swapIdCV, assetContractCV, feesCV];
        postConditions = makeCancelSwapPostConditions(
          feeId,
          contract,
          satsOrUstxCV,
          fees,
          feeContract
        );
        break;
      case 'stx-nft':
        nftIdCV = uintCV(nftIdRef.current.value.trim());

        [assetContractCV, assetName, assetContractName, assetContractAddress] =
          splitAssetIdentifier(traitRef.current.value.trim());
        if (!assetName) {
          setLoading(false);
          setStatus('"ft contract :: ft name" must be set');
          return;
        }
        feeId = feeContractRef.current.value;
        feeContract = ftFeeContracts[feeId];
        [feesCV, fees] = await contractToFees(feeContract, satsOrUstxCV);
        functionArgs = [swapIdCV, assetContractCV, feesCV];
        postConditions = makeCancelSwapPostConditions(
          feeId,
          contract,
          satsOrUstxCV,
          fees,
          feeContract
        );
        break;
      case 'banana-nft':
        nftIdCV = uintCV(nftIdRef.current.value.trim());

        [assetContractCV, assetName, assetContractName, assetContractAddress] =
          splitAssetIdentifier(traitRef.current.value.trim());
        if (!assetName) {
          setLoading(false);
          setStatus('"ft contract :: ft name" must be set');
          return;
        }
        feeId = feeContractRef.current.value;
        feeContract = ftFeeContracts[feeId];
        [feesCV, fees] = await contractToFees(feeContract, satsOrUstxCV);
        functionArgs = [swapIdCV, assetContractCV, feesCV];
        postConditions = makeCancelSwapPostConditions(
          feeId,
          contract,
          satsOrUstxCV,
          fees,
          feeContract
        );
        break;
      default:
        setLoading(false);
        return;
    }
    await handleContractCall({
      functionName: 'cancel',
      functionArgs,
      postConditionMode: PostConditionMode.Deny,
      postConditions,

      onCancel: () => {
        setLoading(false);
      },
      onFinish: result => {
        setLoading(false);
        setTxId(result.txId);
        saveTxData(result, userSession)
          .then(r => {
            setLoading(false);
          })
          .catch(e => {
            console.log(e);
            setLoading(false);
          });
      },
    });
  };

  const submitAction = async () => {
    setLoading(true);

    const factor = factorForType(type);
    const satsOrUstxCV = uintCV(
      Math.floor(parseFloat(amountSatsRef.current.value.trim()) * factor)
    );

    const swapIdCV = uintCV(id);

    let functionArgs;
    let postConditions;

    let amountInSmallestUnit, nftIdCV;
    let assetContractCV, assetName, assetContractName, assetContractAddress;
    let feeId, feeContract, feesCV, fees;

    switch (type) {
      case 'stx-ft':
        amountInSmallestUnit = formData.amount * Math.pow(10, sellDecimals);

        [assetContractCV, assetName, assetContractName, assetContractAddress] =
          splitAssetIdentifier(traitRef.current.value.trim());

        feeId = feeContractRef.current.value;
        feeContract = ftFeeContracts[feeId];
        [feesCV, fees] = await contractToFees(feeContract, satsOrUstxCV);
        if (!fees) {
          setLoading(false);
          setStatus("Couldn't load fees.");
          return;
        }
        functionArgs = [swapIdCV, assetContractCV, feesCV];
        postConditions = [
          makeContractSTXPostCondition(
            contract.address,
            contract.name,
            FungibleConditionCode.Equal,
            satsOrUstxCV.value
          ),
          makeStandardFungiblePostCondition(
            ownerStxAddress,
            FungibleConditionCode.Equal,
            new BN(amountInSmallestUnit),
            createAssetInfo(assetContractAddress, assetContractName, assetName)
          ),
        ];
        if (feeId === 'stx') {
          postConditions.push(
            makeContractSTXPostCondition(
              feeContract.address,
              feeContract.name,
              FungibleConditionCode.Equal,
              fees
            )
          );
        } else {
          postConditions.push(
            makeContractFungiblePostCondition(
              feeContract.address,
              feeContract.name,
              FungibleConditionCode.Equal,
              fees,
              createAssetInfo(feeContract.ft.address, feeContract.ft.name, feeContract.ft.assetName)
            )
          );
        }
        break;

      case 'stx-nft':
        nftIdCV = uintCV(formData.nftId);
        [assetContractCV, assetName, assetContractName, assetContractAddress] =
          splitAssetIdentifier(traitRef.current.value.trim());

        feeId = feeContractRef.current.value;
        feeContract = nftFeeContracts[feeId];
        [feesCV, fees] = await contractToFees(feeContract, satsOrUstxCV);
        if (!fees) {
          setLoading(false);
          setStatus("Couldn't load fees.");
          return;
        }
        functionArgs = [swapIdCV, assetContractCV, feesCV];
        console.log(cvToString(satsOrUstxCV), {
          ownerStxAddress,
          assetContractAddress,
          assetContractName,
        });
        postConditions = [
          makeContractSTXPostCondition(
            contract.address,
            contract.name,
            FungibleConditionCode.Equal,
            satsOrUstxCV.value
          ),
          makeStandardNonFungiblePostCondition(
            ownerStxAddress,
            NonFungibleConditionCode.DoesNotOwn,
            createAssetInfo(assetContractAddress, assetContractName, assetName),
            nftIdCV
          ),
        ];
        if (feeId === 'stx') {
          postConditions.push(
            makeContractSTXPostCondition(
              feeContract.address,
              feeContract.name,
              FungibleConditionCode.Equal,
              fees
            )
          );
        } else {
          postConditions.push(
            makeContractFungiblePostCondition(
              feeContract.address,
              feeContract.name,
              FungibleConditionCode.Equal,
              fees,
              createAssetInfo(feeContract.ft.address, feeContract.ft.name, feeContract.ft.assetName)
            )
          );
        }
        break;
      case 'banana-nft':
        nftIdCV = uintCV(formData.nftId);
        [assetContractCV, assetName, assetContractName, assetContractAddress] =
          splitAssetIdentifier(traitRef.current.value.trim());

        feeId = feeContractRef.current.value;
        feeContract = nftFeeContracts[feeId];
        [feesCV, fees] = await contractToFees(feeContract, satsOrUstxCV);
        if (!fees) {
          setLoading(false);
          setStatus("Couldn't load fees.");
          return;
        }
        functionArgs = [swapIdCV, assetContractCV, feesCV];
        console.log(cvToString(satsOrUstxCV), {
          ownerStxAddress,
          assetContractAddress,
          assetContractName,
        });
        const [, bananaAssetName, bananaContractName, bananaContractAddress] =
          splitAssetIdentifier(BANANA_TOKEN);
        postConditions = [
          makeContractFungiblePostCondition(
            contract.address,
            contract.name,
            FungibleConditionCode.Equal,
            satsOrUstxCV.value,
            createAssetInfo(bananaContractAddress, bananaContractName, bananaAssetName)
          ),
          makeStandardNonFungiblePostCondition(
            ownerStxAddress,
            NonFungibleConditionCode.DoesNotOwn,
            createAssetInfo(assetContractAddress, assetContractName, assetName),
            nftIdCV
          ),
        ];
        if (feeId === 'stx') {
          postConditions.push(
            makeContractSTXPostCondition(
              feeContract.address,
              feeContract.name,
              FungibleConditionCode.Equal,
              fees
            )
          );
        } else {
          postConditions.push(
            makeContractFungiblePostCondition(
              feeContract.address,
              feeContract.name,
              FungibleConditionCode.Equal,
              fees,
              createAssetInfo(feeContract.ft.address, feeContract.ft.name, feeContract.ft.assetName)
            )
          );
        }
        break;
      default:
        setLoading(false);
        return;
    }
    try {
      // submit
      await handleContractCall({
        functionName: 'submit-swap',
        functionArgs,
        postConditionMode: PostConditionMode.Deny,
        postConditions,
        onCancel: () => {
          setLoading(false);
        },
        onFinish: result => {
          console.log(result);
          console.log(result.txId);
          setLoading(false);
          if (result.txId.error) {
            setStatus(result.txId.error + ' ' + result.txId.reason);
            return;
          }
          setTxId(result.txId.txid);
          saveTxData(result, userSession)
            .then(r => {
              setLoading(false);
            })
            .catch(e => {
              console.log(e);
              setLoading(false);
            });
        },
      });
    } catch (e) {
      console.log(e);
      setLoading(false);
    }
  };

  // sell (left to right)
  const sellType = atomicSwap ? type.split('-')[1] : type;
  const sellDecimals =
    sellType === 'stx'
      ? 6
      : type === 'stx-ft' &&
        formData.trait === 'SPN4Y5QPGQA8882ZXW90ADC2DHYXMSTN8VAR8C3X.friedger-token-v1::friedger'
      ? 6
      : type === 'stx-ft' && ftData
      ? ftData.decimals
      : 0;
  const asset = getAsset(sellType, formData.trait);
  const assetName = getAssetName(sellType, formData.trait);
  // buy (right to left)
  const buyWithAsset = buyAssetFromType(type);
  const buyDecimals = buyDecimalsFromType(type);

  const createSellOrder = false;
  return (
    <>
      <h3>
        {id ? null : 'Create'} Swap {buyWithAsset}-{asset} {id ? `#${id}` : null}{' '}
        {formData.doneFromSwap === 1 ? <>(completed)</> : null}
      </h3>
      <Hint type={type} />
      {atomicSwap ? (
        <p>
          Your {buyWithAsset} tokens will be sent to the contract now (including 1% fees) and will
          be released to the buyer if the {assetName} {sellType === 'nft' ? ' is ' : ' are '}{' '}
          transferred to you. If the swap expired after 100 Stacks blocks and you called "cancel"
          your {buyWithAsset} tokens including fees are returned to you.
        </p>
      ) : (
        <p>
          Your {assetName} {type === 'nft' ? ' is ' : ' are '} sent to the contract now and will be
          released to the buyer if the BTC transaction is verified (or back to you if the swap
          expired after 100 Stacks blocks and you called "cancel").
        </p>
      )}
      <form>
        <div className={`input-group ${type === 'stx' ? 'd-none' : ''}`}>
          <input
            type="text"
            className="form-control"
            ref={traitRef}
            value={formData.trait}
            onChange={e => setFormData({ ...formData, trait: e.current.value })}
            aria-label={`fully qualified contract of the ${assetName} and its asset class`}
            placeholder={`fully qualified contract of the ${assetName} and its asset class`}
            readOnly={trait}
            required
            minLength="1"
          />
        </div>
        <div className="container">
          <div className="row align-items-center m-5">
            <div className="col text-center">
              {(!id || formData.assetSenderFromSwap === ownerStxAddress) && !atomicSwap ? (
                <>
                  Seller (You)
                  <br />
                  <Address addr={ownerStxAddress} />
                </>
              ) : (
                <>
                  <br />
                  Seller
                  {formData.assetSenderFromSwap === ownerStxAddress ||
                  (!atomicSwap && !id) ||
                  (atomicSwap &&
                    id &&
                    ((formData.doneFromSwap === 0 && formData.assetSenderFromSwap === 'none') ||
                      formData.assetSenderFromSwap === `(some ${ownerStxAddress})`))
                    ? ' (You)'
                    : null}
                </>
              )}
              <br />
              <div className="input-group">
                <input
                  type="text"
                  className="form-control"
                  ref={assetSellerRef}
                  defaultValue={
                    (formData.btcRecipient
                      ? formData.btcRecipient
                      : formData.assetSenderFromSwap !== 'none'
                      ? formData.assetSenderFromSwap.substr(
                          6,
                          formData.assetSenderFromSwap.length - 7
                        )
                      : undefined) ||
                    (atomicSwap && id && formData.doneFromSwap === 0 ? ownerStxAddress : '')
                  }
                  onChange={e => setFormData({ ...formData, btcRecipient: e.target.value })}
                  aria-label={
                    atomicSwap
                      ? 'Stacks address or name (optional)'
                      : 'Bitcoin recipient address (must start with 1)'
                  }
                  placeholder={
                    atomicSwap
                      ? 'Stacks address or name (optional)'
                      : 'Bitcoin recipient address (must start with 1)'
                  }
                  readOnly={id}
                  required
                  max="40"
                  minLength="1"
                />
              </div>
            </div>
            <div className="col text-center border-left">
              <AssetIcon type={sellType} trait={formData.trait} />
              <br />
              <div className={`input-group ${nftSwap(type) ? '' : 'd-none'}`}>
                <input
                  type="number"
                  className="form-control"
                  ref={nftIdRef}
                  value={formData.nftId}
                  onChange={e => setFormData({ ...formData, nftId: e.target.value })}
                  aria-label="ID of NFT"
                  placeholder="ID of NFT"
                  readOnly={id}
                  required
                  minLength="1"
                />
              </div>
              <div className={`input-group ${nftSwap(type) ? 'd-none' : ''}`}>
                <input
                  type="number"
                  className="form-control"
                  ref={amountRef}
                  value={formData.amount}
                  onChange={e => setFormData({ ...formData, amount: e.target.value })}
                  aria-label={`amount of ${assetName}${type === 'stx' ? '' : ' in smallest unit'}`}
                  placeholder={`amount of ${assetName}${type === 'stx' ? '' : ' in smallest unit'}`}
                  readOnly={id}
                  required
                  minLength="1"
                />
              </div>
              <i className="bi bi-arrow-right"></i>
              <br />
              {!nftSwap(type) && (
                <>
                  <br />
                  <Price
                    sell={{ amount: formData.amount, asset: asset, decimals: sellDecimals }}
                    buy={{
                      amount: formData.amountSats,
                      asset: buyWithAsset,
                      decimals: buyDecimals,
                    }}
                    editablePrice={createSellOrder}
                  />
                  <br />
                  <br />
                </>
              )}
              <i className="bi bi-arrow-left"></i>
              <br />
              <div className="input-group">
                <input
                  type="number"
                  className="form-control"
                  ref={amountSatsRef}
                  value={formData.amountSats}
                  onChange={e => setFormData({ ...formData, amountSats: e.target.value })}
                  aria-label={
                    atomicSwap
                      ? type === 'stx-nft'
                        ? `Price for NFT in STXs`
                        : type === 'banana-nft'
                        ? 'Price of NFT in BANANAs'
                        : `amount of STXs`
                      : type === 'nft'
                      ? `Price for NFT in Bitcoin`
                      : `amount of Bitcoins`
                  }
                  placeholder={
                    atomicSwap
                      ? type === 'stx-nft'
                        ? `Price for NFT in STXs`
                        : type === 'banana-nft'
                        ? 'Price of NFT in BANANAs'
                        : `amount of STXs`
                      : type === 'nft'
                      ? `Price for NFT in Bitcoin`
                      : `amount of Bitcoins`
                  }
                  readOnly={id}
                  required
                  minLength="1"
                />
              </div>
              <AssetIcon type={buyAssetTypeFromSwapType(type)} />
            </div>
            <div className="col text-center">
              {(!id || formData.assetSenderFromSwap === ownerStxAddress) && atomicSwap ? (
                <>
                  Buyer (You)
                  <br />
                  <Address addr={ownerStxAddress} />
                </>
              ) : (
                <>
                  <br />
                  Buyer
                </>
              )}

              <br />
              <div className="input-group">
                <input
                  type="text"
                  className="form-control"
                  ref={assetBuyerRef}
                  value={formData.assetRecipient}
                  onChange={e => setFormData({ ...formData, assetRecipient: e.target.value })}
                  aria-label={`${assetName} receiver's Stacks address`}
                  placeholder={`${assetName} receiver's Stacks address`}
                  readOnly={(id && formData.assetRecipientFromSwap) || atomicSwap}
                  required
                  minLength="1"
                />
              </div>
            </div>
          </div>
          {status && (
            <div className="row align-items-center">
              <div className="col text-center alert">{status}</div>
            </div>
          )}
          {atomicSwap && (
            // fees
            <div className="row m-2">
              <div className="col" />
              <div className="col text-center">
                <select
                  className="form-select form-select-sm"
                  ref={feeContractRef}
                  value={formData.feeId || (type === 'banana-nft' ? 'banana' : 'stx')}
                  onChange={e => setFormData({ ...formData, feeId: e.target.value })}
                  disabled={id}
                  aria-label="select fee model"
                >
                  {type !== 'banana-nft' && <option value="stx">1% fee in STX</option>}
                  {type === 'banana-nft' && <option value="banana">1% fee in BANANA</option>}
                  {type !== 'stx-nft' && <option value="frie">1% fee in FRIE</option>}
                </select>
              </div>
              <div className="col" />
            </div>
          )}
          <div className="row m-2">
            <div className="col-12 text-center">
              {!ownerStxAddress ? (
                <>
                  <button
                    className="btn btn-lg btn-outline-primary mt-4"
                    type="button"
                    onClick={handleSignIn}
                  >
                    Get Started
                  </button>
                </>
              ) : (
                <>
                  {id &&
                    (formData.assetSenderFromSwap === ownerStxAddress ||
                      (atomicSwap && formData.assetRecipientFromSwap === ownerStxAddress)) &&
                    formData.whenFromSwap + 100 < blockHeight &&
                    formData.doneFromSwap === 0 && (
                      <button
                        className="btn btn-block btn-primary"
                        type="button"
                        onClick={cancelAction}
                      >
                        <div
                          role="status"
                          className={`${
                            loading ? '' : 'd-none'
                          } spinner-border spinner-border-sm text-info align-text-top mr-2`}
                        />
                        Cancel swap
                      </button>
                    )}
                  {id ? (
                    // show existing swap
                    atomicSwap ? (
                      formData.doneFromSwap === 1 ? (
                        <>
                          <button className="btn btn-block btn-success" type="button" disabled>
                            Completed
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn btn-block btn-primary"
                          type="button"
                          onClick={submitAction}
                        >
                          <div
                            role="status"
                            className={`${
                              loading ? '' : 'd-none'
                            } spinner-border spinner-border-sm text-info align-text-top mr-2`}
                          />
                          Sell {asset}
                        </button>
                      ) // handle buy with btc
                    ) : formData.assetRecipientFromSwap ? (
                      <></>
                    ) : (
                      <button
                        className="btn btn-block btn-primary"
                        type="button"
                        onClick={setRecipientAction}
                      >
                        <div
                          role="status"
                          className={`${
                            loading ? '' : 'd-none'
                          } spinner-border spinner-border-sm text-info align-text-top mr-2`}
                        />
                        Buy {asset}
                      </button>
                    )
                  ) : (
                    // create new swap
                    <button
                      className="btn btn-block btn-primary"
                      type="button"
                      onClick={createAction}
                    >
                      <div
                        role="status"
                        className={`${
                          loading ? '' : 'd-none'
                        } spinner-border spinner-border-sm text-info align-text-top mr-2`}
                      />
                      {atomicSwap ? 'Buy' : 'Sell'} {asset}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </form>
      {txId && <TxStatus txId={txId} />}
    </>
  );
}

const Hint = ({ type }) => {
  return (
    <>
      {type === 'nft' && (
        <p>For a swap of Bitcoins and an NFT on Stacks, the NFT has to comply with SIP-9.</p>
      )}
      {type === 'ft' && (
        <p>For a swap of Bitcoins and a token on Stacks, the token has to comply with SIP-10.</p>
      )}
      {type === 'stx-ft' && (
        <p>For a swap of Stacks and a token on Stacks, the token has to comply with SIP-10.</p>
      )}
      {type === 'stx-nft' && (
        <p>For a swap of Stacks and a NFT on Stacks, the token has to comply with SIP-9.</p>
      )}
      {type === 'stx-nft' && (
        <p>For a swap of Stacks and a NFT on Stacks, the token has to comply with SIP-9.</p>
      )}
      {type === 'banana-nft' && (
        <p>For a swap of BANANAs and a NFT on Stacks, the NFT has to comply with SIP-9.</p>
      )}
    </>
  );
};
